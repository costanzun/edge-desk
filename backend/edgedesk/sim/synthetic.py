"""Seeded synthetic market in the recorder's exact raw-record format.

Used by the tests (determinism, fault injection), the UI's mock mode and the demo. Spot
follows a GBM; the Deribit chain carries a mild skew around the true vol; prediction-market
quotes are the true digital probability computed from a *lagged* spot plus noise, so a
model that sees the current spot has a real, known edge that decays with latency.
Nothing here is presented as real data anywhere in the app.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import UTC, datetime

from edgedesk.models.pricing import YEAR_S, black_call, digital_flat

NS = 1_000_000_000


@dataclass
class Scenario:
    seed: int = 7
    start_ms: int = 1_794_049_200_000          # 2026-11-07 12:00 UTC
    hours: float = 3.0
    spot0: float = 76_000.0
    vol: float = 0.45
    kalshi_lag_s: float = 20.0                 # how stale Kalshi's quotes are vs spot
    poly_lag_s: float = 6.0
    noise: float = 0.012
    half_spread: float = 0.01
    sym: str = "BTC"


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def generate(sc: Scenario | None = None) -> list[dict]:
    sc = sc or Scenario()
    rng = random.Random(sc.seed)
    recs: list[dict] = []
    seq = 0

    def add(t_ms: int, src: str, kind: str, data: dict, t_exch: int | None = None, rtt: float | None = None,
            jitter_us: int = 0) -> None:
        nonlocal seq
        seq += 1
        recs.append({"seq": seq, "src": src, "kind": kind, "t_recv": t_ms * 1_000_000 + jitter_us,
                     "t_exch": t_exch, "rtt_ms": rtt, "data": data})

    n_s = int(sc.hours * 3600)
    dt = 1.0 / YEAR_S
    path = [sc.spot0]
    for _ in range(n_s + 1):
        z = rng.gauss(0, 1)
        path.append(path[-1] * math.exp(-0.5 * sc.vol ** 2 * dt + sc.vol * math.sqrt(dt) * z))

    def spot_at(sec: float) -> float:
        i = max(0, min(len(path) - 1, int(sec)))
        return path[i]

    # contracts: Kalshi hourly (strike step 250) and Polymarket hourly (step 500), expiring each hour
    t0 = sc.start_ms
    expiries = [t0 + h * 3_600_000 for h in range(1, int(sc.hours) + 1)]
    k_events, p_events = {}, {}
    for e in expiries:
        center = round(sc.spot0 / 250) * 250
        tag = datetime.fromtimestamp(e / 1000, tz=UTC).strftime("%y%b%d%H").upper()
        k_events[e] = (f"KXBTCD-{tag}", [center + 250 * i - 0.01 for i in range(-8, 9)])
        p_events[e] = (f"bitcoin-above-synthetic-{tag.lower()}", [round(sc.spot0 / 500) * 500 + 500 * i
                                                                  for i in range(-4, 5)])
    for e, (slug, strikes) in p_events.items():
        add(t0, "polymarket", "event", {"slug": slug, "sym": sc.sym, "end_ms": e, "title": slug, "markets": [
            {"yes_token": f"{slug}-{int(k)}", "slug": slug, "sym": sc.sym, "strike": float(k), "end_ms": e,
             "market_id": f"m-{slug}-{int(k)}", "no_token": f"{slug}-{int(k)}-no",
             "fee": {"rate": 0.07, "exponent": 1, "takerOnly": True}, "tick": 0.01, "min_size": 5.0}
            for k in strikes]})

    def quote(true_p: float) -> tuple[float, float]:
        p = min(0.985, max(0.015, true_p + rng.gauss(0, sc.noise)))
        bid = math.floor((p - sc.half_spread) * 100) / 100
        ask = math.ceil((p + sc.half_spread) * 100) / 100
        bid = max(0.01, min(0.98, bid))
        ask = max(bid + 0.01, min(0.99, ask))
        return round(bid, 2), round(ask, 2)

    for s in range(n_s):
        t_ms = t0 + s * 1000
        S = spot_at(s)
        if s % 2 == 0:
            add(t_ms, "coinbase", "spot", {"sym": sc.sym, "bid": round(S - 0.5, 2), "ask": round(S + 0.5, 2),
                                           "last": round(S, 2)}, rtt=28.0 + rng.random() * 8, jitter_us=100)
            add(t_ms, "binance", "spot", {"sym": sc.sym, "bid": round(S * 1.0004 - 0.5, 2),
                                          "ask": round(S * 1.0004 + 0.5, 2)}, rtt=210 + rng.random() * 40,
                jitter_us=200)
        if s % 5 == 0:
            add(t_ms, "deribit", "index", {"sym": sc.sym, "price": round(S, 2)}, t_exch=t_ms - 20,
                rtt=40 + rng.random() * 6, jitter_us=300)
        if s % 30 == 0:
            rows = []
            for d in range(1, 4):
                exp = (t_ms // 86_400_000 + d) * 86_400_000 + 8 * 3_600_000
                T = (exp - t_ms) / 1000 / YEAR_S
                for K in range(int(S * 0.9 // 1000) * 1000, int(S * 1.1), 1000):
                    k = math.log(K / S)
                    iv = sc.vol * (1 - 0.15 * k + 2.0 * k * k)
                    for cp in ("C", "P"):
                        c = black_call(S, K, iv, T)
                        px = (c if cp == "C" else c - S + K) / S
                        rows.append([f"{sc.sym}-X-{K}-{cp}", exp, float(K), cp, round(px * 0.98, 6),
                                     round(px * 1.02, 6), round(px, 6), round(iv * 100, 2), S, 10.0])
            add(t_ms, "deribit", "chain", {"sym": sc.sym, "cols": ["name", "exp_ms", "strike", "cp", "bid", "ask",
                                                                   "mark", "mark_iv", "und", "oi"], "rows": rows},
                t_exch=t_ms - 15, rtt=45 + rng.random() * 10, jitter_us=400)
        if s % 10 == 0:
            S_lag = spot_at(s - sc.kalshi_lag_s)
            for e, (ev, strikes) in k_events.items():
                if e <= t_ms:
                    continue
                T = (e - t_ms) / 1000 / YEAR_S
                rows = []
                for K in strikes:
                    bid, ask = quote(digital_flat(S_lag, K, sc.vol, T))
                    rows.append([f"{ev}-T{K:.2f}", K, None, "greater", bid, ask, float(rng.randint(50, 400)),
                                 float(rng.randint(50, 400)), None, 1000.0, 500.0, "active"])
                add(t_ms, "kalshi", "markets", {"event": ev, "sym": sc.sym, "close_ms": e,
                                                "cols": ["ticker", "strike", "cap", "type", "yes_bid", "yes_ask",
                                                         "yes_bid_sz", "yes_ask_sz", "last", "volume", "oi",
                                                         "status"], "rows": rows},
                    rtt=120 + rng.random() * 60, jitter_us=500)
        if s % 2 == 1:
            S_lag = spot_at(s - sc.poly_lag_s) * 1.0004
            for e, (slug, strikes) in p_events.items():
                if e <= t_ms:
                    continue
                T = (e - t_ms) / 1000 / YEAR_S
                for K in strikes:
                    if rng.random() < 0.6:
                        continue
                    bid, ask = quote(digital_flat(S_lag, K, sc.vol, T))
                    bids = [lv for lv in ([bid, float(rng.randint(20, 300))], [round(bid - 0.01, 2), 300.0])
                            if 0 < lv[0] < 1]
                    asks = [lv for lv in ([ask, float(rng.randint(20, 300))], [round(ask + 0.01, 2), 300.0])
                            if 0 < lv[0] < 1]
                    add(t_ms, "polymarket", "ws_top", {"token": f"{slug}-{int(K)}", "ts": t_ms - 30,
                                                       "bids": bids, "asks": asks},
                        t_exch=t_ms - 30, jitter_us=600)
        # outcomes five minutes after each expiry
        for e in expiries:
            if t_ms == e + 300_000:
                S_e = spot_at((e - t0) / 1000)
                ev, strikes = k_events[e]
                add(t_ms, "kalshi", "outcome", {"event": ev, "sym": sc.sym, "close_ms": e,
                                                "cols": ["ticker", "result", "settle_value", "strike"],
                                                "rows": [[f"{ev}-T{K:.2f}", "yes" if S_e > K else "no", round(S_e, 2), K]
                                                         for K in strikes]}, jitter_us=700)
                slug, pstrikes = p_events[e]
                add(t_ms, "polymarket", "outcome", {"slug": slug, "sym": sc.sym, "end_ms": e,
                                                    "cols": ["market_id", "strike", "yes_price", "closed", "uma"],
                                                    "rows": [[f"m-{slug}-{int(K)}", float(K),
                                                              1.0 if S_e * 1.0004 > K else 0.0, True, "resolved"]
                                                             for K in pstrikes]}, jitter_us=800)
    # seed the realized-vol model from "recorded" 1-minute closes
    closes = [round(path[0] * math.exp(sc.vol * math.sqrt(60 * dt) * rng.gauss(0, 1)), 2) for _ in range(120)]
    recs.insert(0, {"seq": 0, "src": "binance", "kind": "kline_1m", "t_recv": t0 * 1_000_000 - 1,
                    "t_exch": None, "rtt_ms": None, "data": {"sym": sc.sym, "rows": [[t0 - (120 - i) * 60_000 - 60_000, c]
                                                                                   for i, c in enumerate(closes)]}})
    recs.sort(key=lambda r: (r["t_recv"], r["seq"]))
    return recs
