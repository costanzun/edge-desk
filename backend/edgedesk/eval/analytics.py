"""Analytics over an engine run: trades, P&L attribution, equity, calibration, latency.

Every function reads the event log or engine state; nothing here changes a decision.
"""

from __future__ import annotations

import math
from collections import defaultdict
from statistics import median
from typing import Any

from edgedesk.core import events as E
from edgedesk.core.engine import Engine

NS = 1_000_000_000
MODELS = ("p_options", "p_hybrid", "p_realized", "p_ensemble", "mid")
MODEL_LABEL = {"p_options": "Options-implied (Deribit)", "p_hybrid": "Hybrid (Deribit smile + realized vol)",
               "p_realized": "Realized vol (spot)", "p_ensemble": "Market ensemble", "mid": "Market mid (baseline)",
               "p_kumo": "KumoRFM"}


def _bucket_tte(s: float) -> str:
    if s < 900:
        return "< 15 min"
    if s < 3600:
        return "15-60 min"
    if s < 6 * 3600:
        return "1-6 h"
    if s < 86400:
        return "6-24 h"
    return "> 1 day"


def _bucket_edge(e: float) -> str:
    if e < 0.03:
        return "2-3c"
    if e < 0.05:
        return "3-5c"
    if e < 0.10:
        return "5-10c"
    return "10c+"


def trades(eng: Engine) -> list[dict[str, Any]]:
    signals = {ev.seq: ev for ev in eng.log.of(E.SIGNAL)}
    out = []
    settled = {(ev.data["cid"], ev.data["side"]): ev for ev in eng.log.of(E.SETTLE)}
    sig_of = {ev.data["oid"]: ev.data.get("signal") for ev in eng.log.of(E.ORDER) if ev.data["event"] == "new"}
    for o in eng.orders.values():
        if o.filled == 0:
            continue
        c = eng.contracts[o.cid]
        sig_seq = sig_of.get(o.oid)
        sig = signals.get(sig_seq)
        sd = sig.data if sig else {}
        p_side = sd.get("p_side")
        touch_dec = sd.get("px")
        touch_arr = o.touch_arrival if o.touch_arrival is not None else touch_dec
        outcome = eng.outcomes.get(o.cid)
        payoff = None if outcome is None else (1.0 if (o.side == "yes") == outcome else 0.0)
        q, px = o.filled, o.avg_px
        mark = eng.mark(o.cid, o.side)
        value = payoff if payoff is not None else mark
        pnl = None if value is None else q * (value - px) - o.fees
        attr = None
        if p_side is not None and touch_dec is not None and value is not None:
            attr = {"edge": q * (p_side - touch_dec), "latency": q * (touch_dec - (touch_arr or touch_dec)),
                    "slippage": q * ((touch_arr or touch_dec) - px), "fees": -o.fees,
                    "model_luck": q * (value - p_side)}
        out.append({
            "oid": o.oid, "t": o.t_new, "venue": o.venue, "cid": o.cid, "sym": c["sym"], "strike": c["strike"],
            "expiry_ms": c["expiry_ms"], "group": c.get("group"), "side": o.side, "qty": q, "avg_px": round(px, 4),
            "fees": round(o.fees, 4), "fair": sd.get("fair"), "p_side": p_side, "edge": sd.get("edge"),
            "model": sd.get("model"), "tte_s": sd.get("tte_s"), "touch_decision": touch_dec,
            "touch_arrival": touch_arr, "outcome": outcome, "settled": (o.cid, o.side) in settled or payoff is not None,
            "pnl": None if pnl is None else round(pnl, 4), "attr": attr, "state": o.state,
            "tte_bucket": _bucket_tte(sd.get("tte_s") or 0), "edge_bucket": _bucket_edge(sd.get("edge") or 0),
        })
    out.sort(key=lambda x: x["t"])
    return out


def pnl_summary(eng: Engine, tr: list[dict] | None = None) -> dict[str, Any]:
    tr = tr if tr is not None else trades(eng)
    settled = [x for x in tr if x["outcome"] is not None]
    open_ = [x for x in tr if x["outcome"] is None]
    net_settled = sum(x["pnl"] for x in settled if x["pnl"] is not None)
    unreal = sum(x["pnl"] for x in open_ if x["pnl"] is not None)
    fees = sum(x["fees"] for x in tr)
    gross = net_settled + sum(x["fees"] for x in settled)
    wins = sum(1 for x in settled if (x["pnl"] or 0) > 0)
    cost = sum(x["qty"] * x["avg_px"] for x in tr)
    return {"trades": len(tr), "settled": len(settled), "open": len(open_), "contracts": sum(x["qty"] for x in tr),
            "cost": round(cost, 2), "gross_settled": round(gross, 2), "fees": round(fees, 2),
            "net_settled": round(net_settled, 2), "unrealized": round(unreal, 2),
            "net_total": round(net_settled + unreal, 2), "win_rate": round(wins / len(settled), 3) if settled else None,
            "return_on_cost": round((net_settled + unreal) / cost, 4) if cost else None,
            "equity": round(eng.equity(), 2), "bankroll": eng.cfg.bankroll,
            "signals": eng.signals, "orders": len(eng.orders), "halted": eng.halted, "halt_reason": eng.halt_reason}


def attribution(tr: list[dict]) -> dict[str, Any]:
    keys = ("edge", "latency", "slippage", "fees", "model_luck")
    total = {k: 0.0 for k in keys}
    groups: dict[str, dict[str, dict[str, float]]] = {g: defaultdict(lambda: {**{k: 0.0 for k in keys}, "pnl": 0.0, "n": 0})
                                                      for g in ("venue", "pairing", "model", "tte_bucket", "edge_bucket")}
    for x in tr:
        a = x["attr"]
        if not a:
            continue
        for k in keys:
            total[k] += a[k]
        for g in groups:
            key = f"{x['sym']} {x['venue']}" if g == "pairing" else str(x[g])
            row = groups[g][key]
            for k in keys:
                row[k] += a[k]
            row["pnl"] += x["pnl"] or 0.0
            row["n"] += 1
    rnd = lambda d: {k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}
    return {"total": rnd(total), "by": {g: {k: rnd(v) for k, v in rows.items()} for g, rows in groups.items()}}


def equity_curve(eng: Engine) -> list[dict[str, Any]]:
    """Realized equity after each settlement (fees charged when paid), plus a final mark."""
    eq = eng.cfg.bankroll
    pts = []
    fee_by_fill = 0.0
    first_t = None
    for ev in eng.log.events:
        if ev.kind == E.FILL:
            fee_by_fill += ev.data["fee"]
            first_t = first_t or ev.t
        elif ev.kind == E.SETTLE:
            eq += ev.data["pnl_gross"] - ev.data["fees"]
            pts.append({"t": ev.t // 1_000_000, "equity": round(eq, 2)})
    if first_t:
        pts.insert(0, {"t": first_t // 1_000_000 - 1, "equity": eng.cfg.bankroll})
    pts.append({"t": eng.t // 1_000_000, "equity": round(eng.equity(), 2), "mark": True})
    peak = -math.inf
    for p in pts:
        peak = max(peak, p["equity"])
        p["drawdown"] = round(p["equity"] - peak, 2)
    return pts


def max_drawdown(curve: list[dict]) -> float:
    return min((p["drawdown"] for p in curve), default=0.0)


# ---------------------------------------------------------------------- calibration
def calibration_samples(eng: Engine, min_tte_s: float = 60.0) -> list[dict]:
    """One row per logged model snapshot of a contract that has since resolved."""
    rows = []
    for ev in eng.log.of(E.MODEL):
        d = ev.data
        y = eng.outcomes.get(d["cid"])
        if y is None or d["tte_s"] < min_tte_s:
            continue
        rows.append({**{m: d.get(m) for m in (*MODELS, "p_kumo")}, "y": 1.0 if y else 0.0, "venue": d["venue"],
                     "sym": d["sym"], "cid": d["cid"], "tte_s": d["tte_s"], "group": eng.contracts[d["cid"]].get("group")})
    return rows


def _scores(ps: list[float], ys: list[float]) -> dict[str, Any]:
    eps = 1e-4
    n = len(ps)
    brier = sum((p - y) ** 2 for p, y in zip(ps, ys)) / n
    ll = -sum(y * math.log(max(eps, p)) + (1 - y) * math.log(max(eps, 1 - p)) for p, y in zip(ps, ys)) / n
    bins = []
    for i in range(10):
        lo, hi = i / 10, (i + 1) / 10
        sel = [(p, y) for p, y in zip(ps, ys) if (lo <= p < hi) or (i == 9 and p == 1.0)]
        if sel:
            bins.append({"lo": lo, "hi": hi, "n": len(sel), "p_mean": round(sum(p for p, _ in sel) / len(sel), 4),
                         "y_rate": round(sum(y for _, y in sel) / len(sel), 4)})
    return {"n": n, "brier": round(brier, 5), "log_loss": round(ll, 5), "bins": bins}


def calibration(rows: list[dict], by: str | None = None) -> dict[str, Any]:
    """Scores per model on the rows where *all compared models* have a value (paired comparison)."""
    out: dict[str, Any] = {}
    groups = defaultdict(list)
    for r in rows:
        groups[r[by] if by else "all"].append(r)
    for g, rs in groups.items():
        models = [m for m in (*MODELS, "p_kumo") if any(r.get(m) is not None for r in rs)]
        paired = [r for r in rs if all(r.get(m) is not None for m in models if m != "p_kumo")]
        res = {}
        for m in models:
            sel = [r for r in (paired if m != "p_kumo" else rs) if r.get(m) is not None]
            if sel:
                res[m] = {**_scores([r[m] for r in sel], [r["y"] for r in sel]), "label": MODEL_LABEL[m]}
        out[g] = {"models": res, "n_snapshots": len(paired), "n_contracts": len({r["cid"] for r in paired}),
                  "n_events": len({r["group"] for r in paired}), "base_rate": round(sum(r["y"] for r in paired) / len(paired), 4) if paired else None}
    return out


# ---------------------------------------------------------------------- latency
def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


def summarize(xs: list[float]) -> dict[str, Any]:
    if not xs:
        return {"n": 0}
    return {"n": len(xs), "p50": round(pct(xs, 0.5), 3), "p95": round(pct(xs, 0.95), 3), "p99": round(pct(xs, 0.99), 3),
            "mean": round(sum(xs) / len(xs), 3), "max": round(max(xs), 3)}


def histogram(xs: list[float], edges: list[float]) -> list[dict]:
    out = []
    for lo, hi in zip(edges, edges[1:]):
        out.append({"lo": lo, "hi": hi, "n": sum(1 for x in xs if lo <= x < hi)})
    out.append({"lo": edges[-1], "hi": None, "n": sum(1 for x in xs if x >= edges[-1])})
    return out


def network_latency(recs) -> dict[str, Any]:
    """Round trips per REST endpoint group, and feed lag (receive time - exchange stamp) for
    WebSocket feeds that stamp their messages."""
    rtt: dict[str, list[float]] = defaultdict(list)
    lag: dict[str, list[float]] = defaultdict(list)
    for r in recs:
        src, kind = r.get("src"), r.get("kind")
        if r.get("rtt_ms") is not None:
            rtt[src].append(float(r["rtt_ms"]))
        te = r.get("t_exch")
        if te and kind in ("ws_top",) and src == "polymarket":
            lag["polymarket book (ws)"].append(r["t_recv"] / 1e6 - te)
        elif te and kind == "index" and (r.get("data") or {}).get("ws"):
            lag["deribit index (ws)"].append(r["t_recv"] / 1e6 - te)
        elif te and kind == "spot" and src == "coinbase" and (r.get("data") or {}).get("ws"):
            lag["coinbase trade (ws)"].append(r["t_recv"] / 1e6 - te)
    edges = [0, 25, 50, 100, 150, 200, 300, 500, 1000, 2000]
    return {"rtt": {k: {**summarize(v), "hist": histogram(v, edges)} for k, v in rtt.items()},
            "feed_lag": {k: {**summarize(v), "hist": histogram(v, [-200, 0, 50, 100, 200, 500, 1000, 5000])}
                         for k, v in lag.items()}}


def hop_latency(eng: Engine) -> dict[str, Any]:
    edges = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500]
    out = {}
    for hop, xs in eng.timings.items():
        us = [x / 1000 for x in xs]
        out[hop] = {**summarize(us), "hist": histogram(us, edges)} if us else {"n": 0}
    return out


def one_way_from_rtt(net: dict[str, Any]) -> dict[str, float]:
    """Order one-way latency per venue assumed as half the median REST round trip we measured."""
    out = {}
    for venue in ("kalshi", "polymarket"):
        r = net["rtt"].get(venue, {})
        if r.get("p50"):
            out[venue] = round(r["p50"] / 2, 1)
    return out


def median_or(xs, default):
    return median(xs) if xs else default
