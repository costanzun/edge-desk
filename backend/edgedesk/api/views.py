"""JSON views over an engine (pure functions). The API serves these; the UI's mock fixtures
are generated from the same functions over the synthetic market, so mock and live agree."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from edgedesk.capital import tools as C
from edgedesk.core import events as E
from edgedesk.core.engine import SPOT_REF, Engine
from edgedesk.eval import analytics as A
from edgedesk.sim import fees as F
from edgedesk.sim import matching as M

NS = 1_000_000_000


def _ms(t: int) -> int:
    return t // 1_000_000


def feeds(eng: Engine, recorder: dict | None = None) -> list[dict]:
    out = []
    rec_health = (recorder or {}).get("health", {})
    names = sorted(set(eng.guard.feeds) | {"kalshi", "polymarket", "deribit", "coinbase", "binance"})
    for n in names:
        fs = eng.guard.feed(n)
        h = rec_health.get(n, {})
        ws = rec_health.get(f"{n}_ws", {})
        out.append({"name": n, "ok": fs.ok, "reason": fs.reason, "last_msg_age_s": round((eng.t - fs.last_t) / NS, 1)
                    if fs.last_t else None, "rtt_ms": h.get("last_rtt_ms"), "errors": h.get("err", 0) + ws.get("err", 0),
                    "messages": h.get("ok", 0) + ws.get("ok", 0), "websocket": bool(ws)})
    return out


def opportunities(eng: Engine, limit: int = 60) -> list[dict]:
    rows = []
    now = eng.t
    for cid, s in eng.last_fair.items():
        c = eng.contracts[cid]
        tte = (c["expiry_ms"] * 1_000_000 - now) / NS
        if tte <= 0 or eng.outcomes.get(cid) is not None:
            continue
        b = eng.books.get(cid)
        if not b:
            continue
        p = s.get({"options": "p_options", "hybrid": "p_hybrid", "ensemble": "p_ensemble",
                   "realized": "p_realized"}.get(eng.cfg.trade_model, "p_options"))
        if p is None or not (0.02 < p < 0.98):
            continue
        band = (s.get("band_hybrid") if eng.cfg.trade_model in ("hybrid", "ensemble") else s.get("band")) or 0
        ya, na = M.best("yes", b.bids, b.asks), M.best("no", b.bids, b.asks)
        edge_yes = p - ya - F.fee_per_contract(c["venue"], ya, False, c) - band if ya is not None else None
        edge_no = (1 - p) - na - F.fee_per_contract(c["venue"], na, False, c) - band if na is not None else None
        best = max([x for x in (edge_yes, edge_no) if x is not None], default=None)
        rows.append({"cid": cid, "venue": c["venue"], "sym": c["sym"], "strike": c["strike"], "expiry_ms": c["expiry_ms"],
                     "group": c.get("group"), "tte_s": round(tte), "bid": b.bids[0][0] if b.bids else None,
                     "ask": b.asks[0][0] if b.asks else None, "bid_sz": b.bids[0][1] if b.bids else None,
                     "ask_sz": b.asks[0][1] if b.asks else None, "book_age_s": round((now - b.t) / NS, 1),
                     "fair": round(p, 4), "band": round(band, 4), "p_options": s.get("p_options"),
                     "p_hybrid": s.get("p_hybrid"), "p_realized": s.get("p_realized"),
                     "p_ensemble": s.get("p_ensemble"), "p_cross": s.get("p_cross"),
                     "edge_yes": None if edge_yes is None else round(edge_yes, 4),
                     "edge_no": None if edge_no is None else round(edge_no, 4),
                     "best_edge": None if best is None else round(best, 4),
                     "signal": None if best is None or best < eng.cfg.min_edge else
                     ("yes" if edge_yes is not None and best == edge_yes else "no"),
                     "spot": s.get("spot"), "ref": c.get("ref")})
    rows.sort(key=lambda r: -(r["best_edge"] if r["best_edge"] is not None else -1))
    return rows[:limit]


def _event_rows(eng: Engine, kinds: tuple[str, ...], limit: int) -> list[dict]:
    evs = [ev for ev in eng.log.events if ev.kind in kinds][-limit:]
    return [{"seq": ev.seq, "t": _ms(ev.t), "kind": ev.kind, **ev.data} for ev in reversed(evs)]


def desk(eng: Engine, recorder: dict | None = None, mode: str = "live") -> dict[str, Any]:
    tr = A.trades(eng)
    s = A.pnl_summary(eng, tr)
    spots = {f"{src}:{sym}": round(v[0], 2) for (src, sym), v in eng.spots.items()}
    return {"t": _ms(eng.t), "mode": mode, "halted": eng.halted, "halt_reason": eng.halt_reason,
            "summary": s, "spots": spots, "feeds": feeds(eng, recorder), "opportunities": opportunities(eng),
            "signals": _event_rows(eng, (E.SIGNAL,), 25), "orders": _event_rows(eng, (E.ORDER,), 25),
            "config": {"trade_model": eng.cfg.trade_model, "min_edge": eng.cfg.min_edge, "band_k": eng.cfg.band_k,
                       "order_style": eng.cfg.order_style, "latency_ms": eng.cfg.latency_ms,
                       "added_latency_ms": eng.cfg.added_latency_ms},
            "counts": dict(eng.log.counts), "digest": eng.log.digest, "contracts": len(eng.contracts)}


def positions(eng: Engine) -> dict[str, Any]:
    tr = A.trades(eng)
    pos = []
    for (cid, side), p in eng.pf.pos.items():
        c = eng.contracts[cid]
        m = eng.mark(cid, side)
        pos.append({"cid": cid, "venue": c["venue"], "sym": c["sym"], "strike": c["strike"], "expiry_ms": c["expiry_ms"],
                    "group": c.get("group"), "side": side, "qty": p.qty, "cost": round(p.cost, 2),
                    "avg_px": round(p.cost / p.qty, 4) if p.qty else None, "fees": round(p.fees, 2), "mark": m,
                    "unrealized": None if m is None else round(p.qty * m - p.cost - p.fees, 2),
                    "fair": (eng.last_fair.get(cid) or {}).get("p_options")})
    pos.sort(key=lambda r: r["expiry_ms"])
    curve = A.equity_curve(eng)
    return {"positions": pos, "trades": list(reversed(tr))[:200], "summary": A.pnl_summary(eng, tr),
            "equity_curve": curve, "max_drawdown": A.max_drawdown(curve), "attribution": A.attribution(tr)}


def exposure(eng: Engine) -> dict[str, Any]:
    by_u: dict[str, float] = defaultdict(float)
    by_e: dict[str, float] = defaultdict(float)
    gross = 0.0
    for (cid, _), p in eng.pf.pos.items():
        c = eng.contracts[cid]
        by_u[c["sym"]] += p.cost
        by_e[f"{c['sym']} {c['expiry_ms']}"] += p.cost
        gross += p.cost
    return {"gross": round(gross, 2), "by_underlying": {k: round(v, 2) for k, v in by_u.items()},
            "by_expiry": [{"key": k, "sym": k.split()[0], "expiry_ms": int(k.split()[1]), "cost": round(v, 2)}
                          for k, v in sorted(by_e.items())],
            "open_orders": sum(1 for o in eng.orders.values() if o.open)}


def risk(eng: Engine, recorder: dict | None = None) -> dict[str, Any]:
    recon = eng.log.of(E.RECON)
    fails = Counter(f for ev in eng.log.of(E.RISK) for f in ev.data["failed"])
    rej = Counter(ev.data["reason"] for ev in eng.log.of(E.REJECT_INPUT))
    return {"halted": eng.halted, "halt_reason": eng.halt_reason, "limits": eng.cfg.limits.as_dict(),
            "exposure": exposure(eng), "day_pnl": round(eng.equity() - eng.day_start_equity, 2),
            "decisions": {"total": eng.log.counts[E.RISK], "accepted": sum(1 for ev in eng.log.of(E.RISK) if ev.data["ok"]),
                          "failed_checks": dict(fails.most_common())},
            "recent": _event_rows(eng, (E.RISK,), 30), "halts": _event_rows(eng, (E.HALT,), 20),
            "recon": {"checks": len(recon), "ok": all(ev.data["ok"] for ev in recon),
                      "last": ({"t": _ms(recon[-1].t), **recon[-1].data} if recon else None)},
            "input_rejects": dict(rej.most_common()), "feeds": feeds(eng, recorder),
            "feed_events": _event_rows(eng, (E.FEED,), 30)}


def capital(eng: Engine) -> dict[str, Any]:
    tr = A.trades(eng)
    rets = [x["pnl"] / eng.cfg.bankroll for x in tr if x["pnl"] is not None]
    # joint allocation over the current opportunity set of the busiest underlying+expiry
    opps = [o for o in opportunities(eng, 200) if o["best_edge"] is not None and o["best_edge"] > 0]
    groups: dict[tuple, list] = defaultdict(list)
    for o in opps:
        groups[(o["sym"], o["expiry_ms"], o["venue"])].append(o)
    alloc = None
    if groups:
        (sym, exp, venue), og = max(groups.items(), key=lambda kv: len(kv[1]))
        og = sorted(og, key=lambda o: -o["best_edge"])[:8]
        sp = eng._spot_for(venue, sym)
        if sp and sym in eng.options.smiles and len(og) >= 1:
            rv = eng.realized.sigma(sym)
            samples = C.sample_terminal(eng.options, sym, sp[0], exp, eng.t, n=20_000,
                                        short_vol=rv if eng.cfg.trade_model in ("hybrid", "ensemble") else None)
            items = []
            for o in og:
                side = o["signal"] or ("yes" if (o["edge_yes"] or -1) >= (o["edge_no"] or -1) else "no")
                px = o["ask"] if side == "yes" else (1 - o["bid"] if o["bid"] is not None else None)
                if px is None:
                    continue
                cost = px + F.fee_per_contract(venue, px)
                items.append({"id": o["cid"], "strike": o["strike"], "side": side, "cost": round(cost, 4),
                              "p": round(o["fair"] if side == "yes" else 1 - o["fair"], 4)})
            alloc = {"sym": sym, "expiry_ms": exp, "venue": venue,
                     **C.joint_allocation(items, samples, fraction=eng.cfg.kelly_fraction)}
    curve = A.equity_curve(eng)
    return {"bankroll": eng.cfg.bankroll, "kelly_fraction": eng.cfg.kelly_fraction,
            "equity_curve": curve, "max_drawdown": A.max_drawdown(curve), "stats": C.stats(rets),
            "risk_of_ruin": C.risk_of_ruin(rets, n_trades=500, paths=2000) if rets else {"n_source_trades": 0},
            "attribution": A.attribution(tr), "allocation": alloc,
            "kelly_example": C.kelly(0.62, 0.55, F.fee_per_contract("kalshi", 0.55), 0.02, eng.cfg.kelly_fraction,
                                     eng.cfg.bankroll)}


def models(eng: Engine, kumo: dict | None = None) -> dict[str, Any]:
    rows = A.calibration_samples(eng)
    return {"all": A.calibration(rows).get("all"), "by_venue": A.calibration(rows, "venue"),
            "by_sym": A.calibration(rows, "sym"), "kumo": kumo or {"enabled": False, "available": False},
            "resolved_contracts": len(eng.outcomes), "labels": A.MODEL_LABEL}


def latency(eng: Engine, recs: list | None = None, net: dict | None = None, decay: list | None = None) -> dict[str, Any]:
    net = net or (A.network_latency(recs) if recs is not None else {"rtt": {}, "feed_lag": {}})
    return {"network": net, "hops": A.hop_latency(eng), "one_way_ms": eng.cfg.latency_ms,
            "added_latency_ms": eng.cfg.added_latency_ms, "edge_decay": decay or [],
            "spot_ref": SPOT_REF}
