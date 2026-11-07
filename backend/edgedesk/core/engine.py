"""The trading engine: a deterministic, single-threaded discrete-event fold.

Inputs are normalized market-data events in receive-time order. The engine keeps a
scheduler for its own future events (orders arriving at the venue after the modelled
latency, venue reports coming back). Before each input at time t, every scheduled event
with time <= t runs first, so an order that arrives at the venue at t_arr is matched
against exactly the book the venue had at t_arr (as far as our recording knows it).

Nothing in here reads the wall clock. CPU timings per hop are measured into a side
channel (``self.timings``) that never touches the event log, so replays stay
bit-for-bit identical while still reporting real internal latency.
"""

from __future__ import annotations

import heapq
import math
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any

from edgedesk.core import events as E
from edgedesk.core.events import EventLog
from edgedesk.core.guard import IngestGuard
from edgedesk.models.ensemble import interp_curve, pool
from edgedesk.models.options_implied import OptionsImplied
from edgedesk.models.realized import RealizedVol
from edgedesk.risk.limits import OrderRequest, RiskContext, RiskEngine, RiskLimits
from edgedesk.sim import fees as F
from edgedesk.sim import matching as M
from edgedesk.sim.ledger import Ledger, Portfolio, reconcile
from edgedesk.sim.orders import (
    ACKED,
    CANCELLED,
    EXPIRED,
    FILLED,
    NEW,
    PARTIAL,
    REJECTED,
    IllegalTransition,
    Order,
)

NS = 1_000_000_000
MS = 1_000_000
SPOT_REF = {"kalshi": "coinbase", "polymarket": "binance"}
HOPS = ("parse", "guard", "model", "signal", "risk", "order")


@dataclass
class Config:
    trade_model: str = "options"            # options | hybrid | ensemble | realized
    venues: tuple[str, ...] = ("kalshi", "polymarket")
    syms: tuple[str, ...] = ("BTC", "ETH")
    min_edge: float = 0.02                  # required edge per contract after fees and band
    band_k: float = 1.0                     # how many model error bands to subtract
    kelly_fraction: float = 0.25
    bankroll: float = 10_000.0
    latency_ms: dict[str, float] = field(default_factory=lambda: {"kalshi": 60.0, "polymarket": 40.0})
    added_latency_ms: float = 0.0           # for the edge-decay curve
    decision_us: int = 500                  # modelled internal decision time (deterministic)
    depth_haircut: float = 0.5
    cooldown_s: float = 30.0
    min_tte_s: float = 300.0
    max_tte_s: float = 3 * 86400.0
    order_style: str = "taker"              # taker (IOC) | maker (resting, trade-through fills)
    maker_ttl_s: float = 60.0
    model_log_every_s: float = 60.0
    spot_eval_bps: float = 2.0
    trade: bool = True
    recon_every: int = 1                    # reconcile after every N fills/settlements
    limits: RiskLimits = field(default_factory=RiskLimits)

    def as_dict(self) -> dict:
        d = asdict(self)
        d["venues"], d["syms"] = list(self.venues), list(self.syms)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> Config:
        d = dict(d)
        lim = RiskLimits(**d.pop("limits", {}) or {})
        for k in ("venues", "syms"):
            if k in d:
                d[k] = tuple(d[k])
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__}, limits=lim)


@dataclass
class Book:
    bids: list
    asks: list
    t: int
    depth: bool


class Engine:
    def __init__(self, cfg: Config | None = None, log: EventLog | None = None, measure: bool = True) -> None:
        self.cfg = cfg or Config()
        self.log = log or EventLog(keep_kinds={E.SIGNAL, E.ORDER, E.FILL, E.SETTLE, E.RISK, E.HALT, E.RECON,
                                               E.FEED, E.MODEL, E.CONTROL, E.REJECT_INPUT})
        self.guard = IngestGuard(self._emit)
        self.options = OptionsImplied()
        self.realized = RealizedVol()
        self.risk = RiskEngine(self.cfg.limits)
        self.ledger = Ledger(self.cfg.bankroll)
        self.pf = Portfolio(self.cfg.bankroll)
        self.t = 0
        self.contracts: dict[str, dict] = {}
        self.by_group: dict[tuple[str, str, int], list[str]] = defaultdict(list)  # (venue, sym, exp) -> cids
        self.books: dict[str, Book] = {}
        self.consumed: dict[str, dict] = defaultdict(dict)
        self.spots: dict[tuple[str, str], tuple[float, int]] = {}
        self.outcomes: dict[str, bool] = {}
        self.orders: dict[int, Order] = {}
        self.keys: dict[str, int] = {}
        self.cooldown: dict[str, int] = {}
        self.last_model_log: dict[str, int] = {}
        self.last_eval_spot: dict[str, float] = {}
        self.live_p: dict[str, float] = {}     # last options-implied p (for spot-move re-eval filter)
        self.last_fair: dict[str, dict] = {}   # latest model snapshot per contract (UI)
        self.halted = False
        self.halt_reason = ""
        self.day = None
        self.day_start_equity = self.cfg.bankroll
        self._sched: list[tuple[int, int, int, str, Any]] = []
        self._n = 0
        self._oid = 0
        self._fills_since_recon = 0
        self.measure = measure
        self.timings: dict[str, list[int]] = {h: [] for h in HOPS}
        self.signals = 0

    # ------------------------------------------------------------------ plumbing
    def _emit(self, t: int, kind: str, data: dict) -> E.Event:
        return self.log.append(t, kind, data)

    def _schedule(self, t: int, prio: int, what: str, payload: Any) -> None:
        self._n += 1
        heapq.heappush(self._sched, (t, prio, self._n, what, payload))

    def _run_until(self, t: int) -> None:
        while self._sched and self._sched[0][0] <= t:
            ts, _, _, what, payload = heapq.heappop(self._sched)
            self.t = max(self.t, ts)
            getattr(self, f"_on_{what}")(ts, payload)

    def finish(self, t: int | None = None) -> None:
        """Drain scheduled events (orders still in flight at the end of the data)."""
        self._run_until(t if t is not None else (self._sched[-1][0] if self._sched else self.t) + 3600 * NS)

    def _tick(self, hop: str, t0: int) -> int:
        t1 = time.perf_counter_ns()
        if self.measure:
            self.timings[hop].append(t1 - t0)
        return t1

    # ------------------------------------------------------------------ input
    def process(self, t: int, kind: str, data: dict) -> None:
        t0 = time.perf_counter_ns() if self.measure else 0
        self._run_until(t)
        if not self.guard.admit(t, kind, data):
            return
        t0 = self._tick("guard", t0) if self.measure else 0
        self.t = t
        self._new_day(t)
        if kind == E.MD_BOOK:
            self._emit(t, kind, data)
            cid = data["cid"]
            if cid not in self.contracts:
                return
            self.books[cid] = Book(data["bids"], data["asks"], t, data.get("depth", True))
            self.consumed.pop(cid, None)
            self._check_resting(t, cid)
            self._evaluate(t, cid, t0)
        elif kind == E.MD_SPOT:
            self._emit(t, kind, data)
            mid = (data["bid"] + data["ask"]) / 2
            self.spots[(data["src"], data["sym"])] = (mid, t)
            if data["src"] == "coinbase":
                self.realized.on_spot(data["sym"], mid, t)
            last = self.last_eval_spot.get(f"{data['src']}:{data['sym']}")
            if last is None or abs(mid / last - 1) * 1e4 >= self.cfg.spot_eval_bps:
                self.last_eval_spot[f"{data['src']}:{data['sym']}"] = mid
                for venue, src in SPOT_REF.items():
                    if src != data["src"]:
                        continue
                    for (v, sym, _exp), cids in self.by_group.items():
                        if v == venue and sym == data["sym"]:
                            for cid in cids:
                                if 0.02 < self.live_p.get(cid, 0.5) < 0.98 and cid in self.books:
                                    self._evaluate(t, cid, time.perf_counter_ns() if self.measure else 0)
        elif kind == E.MD_CHAIN:
            self._emit(t, kind, {"sym": data["sym"], "n": len(data["rows"]), "rseq": data.get("rseq")})
            self.options.on_chain(data["sym"], data["rows"], t)
        elif kind == E.MD_INDEX:
            self._emit(t, kind, data)
        elif kind == "md.kline1m":
            self._emit(t, kind, {"sym": data["sym"], "n": len(data["closes"]), "rseq": data.get("rseq")})
            self.realized.seed(data["sym"], data["closes"])
        elif kind == E.MD_CONTRACT:
            self._emit(t, kind, data)
            cid = data["cid"]
            if cid not in self.contracts:
                self.contracts[cid] = data
                self.by_group[(data["venue"], data["sym"], data["expiry_ms"])].append(cid)
        elif kind == E.MD_OUTCOME:
            self._emit(t, kind, data)
            self._settle(t, data["cid"], data["yes"])
        elif kind == E.MD_FEED_ERROR:
            self._emit(t, kind, data)
        elif kind == E.CONTROL:
            self._emit(t, kind, data)
            self._control(t, data)

    def _new_day(self, t: int) -> None:
        day = t // (86400 * NS)
        if day != self.day:
            self.day = day
            self.day_start_equity = self.equity()

    # ------------------------------------------------------------------ control
    def _control(self, t: int, d: dict) -> None:
        action = d.get("action")
        if action == "kill":
            self.kill(t, d.get("reason") or "kill switch")
        elif action == "resume":
            if self.halted:
                self.halted, self.halt_reason = False, ""
                self._emit(t, E.HALT, {"halted": False, "reason": d.get("reason") or "resumed by operator"})

    def kill(self, t: int, reason: str) -> None:
        """Kill switch: block new orders and cancel every open order (cancel requests take the
        same one-way latency as orders; an IOC order already at the venue still executes)."""
        if not self.halted:
            self.halted, self.halt_reason = True, reason
            self._emit(t, E.HALT, {"halted": True, "reason": reason})
        for o in self.orders.values():
            if o.open:
                lat = self._latency_ns(o.venue)
                self._schedule(t + lat, 1, "cancel_arrive", o.oid)

    # ------------------------------------------------------------------ model + signal
    def _spot_for(self, venue: str, sym: str) -> tuple[float, int] | None:
        return self.spots.get((SPOT_REF[venue], sym)) or self.spots.get(("coinbase", sym))

    def _cross_mid(self, c: dict) -> float | None:
        other = "polymarket" if c["venue"] == "kalshi" else "kalshi"
        pts = []
        for cid in self.by_group.get((other, c["sym"], c["expiry_ms"]), []):
            b = self.books.get(cid)
            if b and self.t - b.t < 60 * NS:
                m = M.mid(b.bids, b.asks, 0.10)
                if m is not None:
                    pts.append((self.contracts[cid]["strike"], m))
        return interp_curve(pts, c["strike"])

    def fair_value(self, t: int, cid: str) -> dict | None:
        c = self.contracts[cid]
        sp = self._spot_for(c["venue"], c["sym"])
        if sp is None:
            return None
        spot, st = sp
        spot_age = (t - st) / NS
        f = self.options.fair(c["sym"], spot, c["strike"], c["expiry_ms"], t, spot_age)
        if f is None:
            return None
        p_rv = self.realized.fair(c["sym"], spot, c["strike"], c["expiry_ms"], t)
        rv = self.realized.sigma(c["sym"])
        h = self.options.fair(c["sym"], spot, c["strike"], c["expiry_ms"], t, spot_age, short_vol=rv) \
            if (rv is not None and f.extrapolated) else f
        b = self.books.get(cid)
        own = M.mid(b.bids, b.asks, 0.10) if b else None
        cross = self._cross_mid(c)
        p_ens = pool({"options": h.p, "realized": p_rv, "cross": cross, "own": own})
        return {"p_options": f.p, "band": f.band, "sigma": f.sigma, "extrap": f.extrapolated,
                "p_hybrid": h.p, "band_hybrid": h.band, "rv": rv,
                "p_realized": p_rv, "p_cross": cross, "mid": own, "p_ensemble": p_ens, "spot": spot,
                "spot_age_s": spot_age}

    def _evaluate(self, t: int, cid: str, t0: int) -> None:
        c = self.contracts[cid]
        tte = (c["expiry_ms"] * MS - t) / NS
        if tte <= 0 or c["sym"] not in self.cfg.syms or c["venue"] not in self.cfg.venues:
            return
        fv = self.fair_value(t, cid)
        if self.measure:
            t0 = self._tick("model", t0)
        if fv is None:
            return
        self.live_p[cid] = fv["p_options"]
        b = self.books[cid]
        snap = {"cid": cid, "venue": c["venue"], "sym": c["sym"], "strike": c["strike"], "expiry_ms": c["expiry_ms"],
                "tte_s": round(tte, 1), **{k: (round(v, 6) if isinstance(v, float) else v) for k, v in fv.items()},
                "bid": b.bids[0][0] if b.bids else None, "ask": b.asks[0][0] if b.asks else None}
        self.last_fair[cid] = snap
        last = self.last_model_log.get(cid)
        if last is None or t - last >= self.cfg.model_log_every_s * NS:
            self.last_model_log[cid] = t
            self._emit(t, E.MODEL, snap)
        if not self.cfg.trade or tte < self.cfg.min_tte_s or tte > self.cfg.max_tte_s:
            return
        if self.cooldown.get(cid, 0) > t:
            return
        p = {"options": fv["p_options"], "hybrid": fv["p_hybrid"], "ensemble": fv["p_ensemble"],
             "realized": fv["p_realized"]}.get(self.cfg.trade_model)
        if p is None:
            return
        band = (fv["band_hybrid"] if self.cfg.trade_model in ("hybrid", "ensemble") else fv["band"]) * self.cfg.band_k
        best = None
        for side in ("yes", "no"):
            px = M.best(side, b.bids, b.asks)
            if px is None:
                continue
            p_side = p if side == "yes" else 1 - p
            if self.cfg.order_style == "maker":
                tick = c.get("tick") or 0.01
                px = math.floor((p_side - band - self.cfg.min_edge) / tick) * tick
                other = M.best("no" if side == "yes" else "yes", b.bids, b.asks)
                if px <= 0 or (other is not None and px >= 1 - other - 1e-9):
                    continue  # would cross the spread: that is a taker trade, not a quote
                fee = 0.0
            else:
                fee = F.fee_per_contract(c["venue"], px, False, c)
            edge = p_side - px - fee - band
            if edge >= self.cfg.min_edge and (best is None or edge > best[2]):
                best = (side, px, edge, fee, p_side)
        if self.measure:
            t0 = self._tick("signal", t0)
        if best is None:
            return
        side, px, edge, fee, p_side = best
        self.signals += 1
        sig = self._emit(t, E.SIGNAL, {"cid": cid, "venue": c["venue"], "side": side, "px": px, "fair": round(p, 6),
                                       "p_side": round(p_side, 6), "band": round(band, 6), "fee": round(fee, 6),
                                       "edge": round(edge, 6), "model": self.cfg.trade_model, "tte_s": round(tte, 1)})
        self.cooldown[cid] = t + int(self.cfg.cooldown_s * NS)
        self._order_for_signal(t, c, sig, side, px, edge, fee, p_side, band, p, t0)

    # ------------------------------------------------------------------ sizing + risk
    def kelly_qty(self, p_side: float, band: float, cost: float) -> int:
        p_cons = p_side - band
        if cost <= 0 or cost >= 1 or p_cons <= cost:
            return 0
        f_star = (p_cons - cost) / (1 - cost)
        stake = self.cfg.kelly_fraction * f_star * max(0.0, self.equity())
        return int(stake // cost)

    def _exposure(self, c: dict) -> tuple[float, float, float, float, int]:
        cost_m = cost_e = cost_u = gross = 0.0
        for (cid, _side), pos in self.pf.pos.items():
            cc = self.contracts.get(cid)
            if not cc:
                continue
            gross += pos.cost
            if cc["sym"] == c["sym"]:
                cost_u += pos.cost
                if cc["expiry_ms"] == c["expiry_ms"]:
                    cost_e += pos.cost
            if cid == c["cid"]:
                cost_m += pos.cost
        n_open = 0
        for o in self.orders.values():
            if not o.open:
                continue
            n_open += 1
            pending = o.limit * o.remaining
            cc = self.contracts[o.cid]
            gross += pending
            if cc["sym"] == c["sym"]:
                cost_u += pending
                if cc["expiry_ms"] == c["expiry_ms"]:
                    cost_e += pending
            if o.cid == c["cid"]:
                cost_m += pending
        return cost_m, cost_e, cost_u, gross, n_open

    def _risk_ctx(self, t: int, c: dict) -> RiskContext:
        b = self.books.get(c["cid"])
        sp = self._spot_for(c["venue"], c["sym"])
        chain_t = self.options.chain_t.get(c["sym"])
        venue_feed = self.guard.feed(c["venue"])
        spot_feed = self.guard.feed(SPOT_REF[c["venue"]])
        der = self.guard.feed("deribit")
        bad = [f"{n}: {fs.reason}" for n, fs in ((c["venue"], venue_feed), (SPOT_REF[c["venue"]], spot_feed),
                                                ("deribit", der)) if not fs.ok]
        cost_m, cost_e, cost_u, gross, n_open = self._exposure(c)
        return RiskContext(
            t=t, halted=self.halted, halt_reason=self.halt_reason,
            book_age_s=(t - b.t) / NS if b else 1e9, spot_age_s=(t - sp[1]) / NS if sp else 1e9,
            chain_age_s=(t - chain_t) / NS if chain_t else 1e9, feed_ok=not bad, feed_reason="; ".join(bad),
            open_orders=n_open, cost_market=cost_m, cost_expiry=cost_e, cost_underlying=cost_u, gross=gross,
            day_pnl=self.equity() - self.day_start_equity)

    def _order_for_signal(self, t, c, sig, side, px, edge, fee, p_side, band, p, t0) -> None:
        tick = c.get("tick") or 0.01
        if self.cfg.order_style == "maker":
            limit = px
        else:
            # pay up to the price that still leaves min_edge after fees and band
            limit = math.floor((p_side - band - self.cfg.min_edge - fee) / tick + 1e-9) * tick
            limit = round(max(px, limit), 6)
        ctx = self._risk_ctx(t, c)
        qty = min(self.kelly_qty(p_side, band, limit + fee), self.risk.headroom(limit, ctx))
        min_size = int(math.ceil(c.get("min_size") or 1))
        if 0 < qty < min_size:
            qty = 0
        req = OrderRequest(c["venue"], c["cid"], c["sym"], c["expiry_ms"], side, round(limit, 6), qty, p,
                           edge)
        ok, checks = self.risk.check(req, ctx)
        if self.measure:
            t0 = self._tick("risk", t0)
        self._emit(t, E.RISK, {"signal": sig.seq, "cid": c["cid"], "ok": ok, "qty": qty, "limit": req.limit,
                               "failed": [x["check"] for x in checks if not x["ok"]], "checks": checks})
        if ctx.day_pnl <= -self.cfg.limits.daily_loss_limit and not self.halted:
            self.kill(t, f"daily loss limit hit ({ctx.day_pnl:.2f})")
        if not ok:
            return
        key = f"{self.cfg.trade_model}:{c['cid']}:{side}:{sig.seq}"
        self.submit(t + self.cfg.decision_us * 1000, c, side, req.limit, qty, key,
                    reason=f"edge {edge:.3f} vs fair {p:.3f}", signal=sig.seq)
        if self.measure:
            self._tick("order", t0)

    # ------------------------------------------------------------------ exchange (paper)
    def _latency_ns(self, venue: str) -> int:
        return int((self.cfg.latency_ms.get(venue, 50.0) + self.cfg.added_latency_ms) * MS)

    def submit(self, t: int, c: dict, side: str, limit: float, qty: int, key: str, reason: str = "",
               signal: int | None = None) -> Order:
        """Same interface a live adapter would expose. Idempotent on ``key``."""
        if key in self.keys:
            o = self.orders[self.keys[key]]
            self._emit(t, E.ORDER, {**o.as_dict(), "event": "duplicate_key_ignored"})
            return o
        self._oid += 1
        maker = self.cfg.order_style == "maker"
        o = Order(self._oid, key, c["venue"], c["cid"], side, limit, qty, "gtt" if maker else "ioc", t,
                  expire_t=t + int(self.cfg.maker_ttl_s * NS) if maker else None, maker=maker, reason=reason)
        self.orders[o.oid] = o
        self.keys[key] = o.oid
        self._emit(t, E.ORDER, {**o.as_dict(), "event": "new", "signal": signal})
        self._schedule(t + self._latency_ns(o.venue), 0, "arrive", o.oid)
        return o

    def _transition(self, o: Order, state: str, t: int, **extra) -> None:
        try:
            o.transition(state, t)
        except IllegalTransition as e:
            self._halt(t, f"order state machine violation: {e}")
            return
        self._emit(t, E.ORDER, {**o.as_dict(), "event": state, **extra})

    def _on_arrive(self, t: int, oid: int) -> None:
        o = self.orders[oid]
        if not o.open:
            return
        c = self.contracts[o.cid]
        back = t + self._latency_ns(o.venue)  # the venue's report reaches us one hop later
        reason = None
        if c["expiry_ms"] * MS <= t or self.outcomes.get(o.cid) is not None:
            reason = "market closed"
        elif not (0 < o.limit < 1):
            reason = "price out of range"
        elif o.qty < (c.get("min_size") or 1):
            reason = "below minimum size"
        if reason:
            self._schedule(back, 0, "report", (oid, "reject", reason, []))
            return
        b = self.books.get(o.cid)
        fills: list[tuple[float, int]] = []
        if b and not o.maker:
            fills = M.take(o.side, o.limit, o.qty, b.bids, b.asks, self.consumed[o.cid], self.cfg.depth_haircut)
        o.touch_arrival = M.best(o.side, b.bids, b.asks) if b else None
        self._schedule(back, 0, "report", (oid, "ack", "", fills))

    def _on_report(self, t: int, payload) -> None:
        oid, what, reason, fills = payload
        o = self.orders[oid]
        if what == "reject":
            if o.state == NEW:
                self._transition(o, REJECTED, t, why=reason)
            return
        if o.state == NEW:
            self._transition(o, ACKED, t, touch_arrival=getattr(o, "touch_arrival", None))
        if not o.open:
            return
        if fills:
            self._apply_fills(t, o, fills)
        if not o.maker and o.open:
            self._transition(o, EXPIRED, t, why="IOC remainder")
        if o.maker and o.open and o.expire_t:
            self._schedule(max(o.expire_t, t), 2, "expire", oid)

    def _apply_fills(self, t: int, o: Order, fills: list[tuple[float, int]]) -> None:
        c = self.contracts[o.cid]
        if o.venue == "kalshi":
            # fee for the whole execution, rounded up to the cent once (Kalshi order accumulator)
            total_fee = F.kalshi_order_fee([(q, p) for p, q in fills], maker=o.maker)
            exact = sum(F.KALSHI_TAKER * q * p * (1 - p) for p, q in fills) or 1.0
        for px, q in fills:
            if q <= 0:
                continue
            if o.venue == "kalshi":
                fee = 0.0 if o.maker else total_fee * (F.KALSHI_TAKER * q * px * (1 - px)) / exact
            else:
                fee = F.fee(o.venue, q, px, o.maker, c)
            o.filled += q
            o.notional += q * px
            o.fees += fee
            self.ledger.fill(t, o.cid, o.side, q, px, fee)
            self.pf.fill(o.cid, o.side, q, px, fee)
            self._emit(t, E.FILL, {"oid": o.oid, "cid": o.cid, "venue": o.venue, "side": o.side, "px": px,
                                   "qty": q, "fee": round(fee, 6), "maker": o.maker})
            self._transition(o, FILLED if o.filled >= o.qty else PARTIAL, t)
            self._recon_tick(t)

    def _check_resting(self, t: int, cid: str) -> None:
        b = self.books[cid]
        for o in list(self.orders.values()):
            if o.cid != cid or not o.maker or o.state not in (ACKED, PARTIAL):
                continue
            q = M.trade_through(o.side, o.limit, o.remaining, b.bids, b.asks, self.cfg.depth_haircut)
            if q > 0:
                self._apply_fills(t, o, [(o.limit, q)])

    def _on_expire(self, t: int, oid: int) -> None:
        o = self.orders[oid]
        if o.state in (ACKED, PARTIAL):
            self._transition(o, EXPIRED, t, why="time in force")

    def _on_cancel_arrive(self, t: int, oid: int) -> None:
        o = self.orders[oid]
        if o.state in (ACKED, PARTIAL):
            self._transition(o, CANCELLED, t, why="kill switch")
        elif o.state == NEW:
            self._transition(o, CANCELLED, t, why="kill switch (before venue ack)")

    # ------------------------------------------------------------------ settlement + recon
    def _settle(self, t: int, cid: str, yes: bool) -> None:
        if cid in self.outcomes:
            return
        self.outcomes[cid] = yes
        for side in ("yes", "no"):
            if (cid, side) not in self.pf.pos:
                continue
            payout = 1.0 if (side == "yes") == yes else 0.0
            pos = self.pf.pos[(cid, side)]
            qty, cost, fees = pos.qty, pos.cost, pos.fees
            pnl_l = self.ledger.settle(t, cid, side, payout)
            pnl_p = self.pf.settle(cid, side, payout)
            self._emit(t, E.SETTLE, {"cid": cid, "side": side, "qty": qty, "cost": round(cost, 6),
                                     "fees": round(fees, 6), "payout": payout * qty, "outcome": yes,
                                     "pnl": round(pnl_p - fees, 6), "pnl_gross": round(pnl_p, 6),
                                     "ledger_pnl": round(pnl_l, 6)})
            self._recon_tick(t)

    def _recon_tick(self, t: int) -> None:
        self._fills_since_recon += 1
        if self._fills_since_recon >= self.cfg.recon_every:
            self._fills_since_recon = 0
            self.reconcile(t)

    def reconcile(self, t: int) -> list[str]:
        breaks = reconcile(self.ledger, self.pf)
        self._emit(t, E.RECON, {"ok": not breaks, "breaks": breaks})
        if breaks:
            self._halt(t, "reconciliation break: " + "; ".join(breaks[:3]))
        return breaks

    def _halt(self, t: int, reason: str) -> None:
        self.kill(t, reason)

    # ------------------------------------------------------------------ valuation
    def mark(self, cid: str, side: str) -> float | None:
        b = self.books.get(cid)
        if not b:
            return None
        m = M.mid(b.bids, b.asks, 0.5)
        if m is None:
            return None
        return m if side == "yes" else 1 - m

    def equity(self) -> float:
        eq = self.pf.cash
        for (cid, side), pos in self.pf.pos.items():
            m = self.mark(cid, side)
            eq += pos.qty * (m if m is not None else pos.cost / max(pos.qty, 1))
        return eq
