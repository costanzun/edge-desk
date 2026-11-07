"""Historical study: a week of settled Kalshi hourly BTC/ETH brackets.

    uv run python -m edgedesk.eval.backfill --days 7        # fetch (cached, resumable) + analyse

The live recorder gives the full-fidelity data (order books, Deribit smile, Polymarket
WebSocket) but only for as long as it has been running. This study trades depth for
breadth: Kalshi 1-minute top-of-book candles for every near-the-money strike of every
hourly event in the window, Coinbase 1-minute spot, and Deribit's DVOL index (30-day ATM
implied vol; the full historical smile is not freely available, so DVOL is the options
proxy here). It answers one question with a real sample size: at 5-45 minutes to expiry,
are vol-model probabilities better calibrated than the Kalshi price, and does a simple
threshold rule make money after fees at the top of book?
"""

from __future__ import annotations

import argparse
import asyncio
import math
import random
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson

from edgedesk.eval.analytics import _scores
from edgedesk.models.pricing import YEAR_S, digital_flat, logit, sigmoid
from edgedesk.sim.fees import fee_per_contract
from edgedesk.venues.http import PoliteClient

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / "data" / "backfill"
OUT = ROOT / "eval" / "results" / "backfill.json"
KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
SERIES = {"KXBTCD": "BTC", "KXETHD": "ETH"}
HORIZONS_MIN = (45, 30, 15, 5)
BAND = {"BTC": 0.008, "ETH": 0.010}  # strikes within this fraction of the settlement value


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ts(s: str) -> int:
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def _cache(name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    return CACHE / name


async def fetch(days: float) -> None:
    http = PoliteClient(rates={"api.elections.kalshi.com": 2.0, "api.exchange.coinbase.com": 2.0})
    end = int(time.time()) - 3600
    start = end - int(days * 86400)
    try:
        # 1. settled markets per series (paginated)
        for series, sym in SERIES.items():
            path = _cache(f"markets_{series}_{start // 86400}_{end // 3600}.json")
            if path.exists():
                continue
            markets, cursor = [], ""
            while True:
                params = {"series_ticker": series, "status": "settled", "min_close_ts": start, "max_close_ts": end,
                          "limit": 1000}
                if cursor:
                    params["cursor"] = cursor
                r = await http.get(f"{KALSHI}/markets", **params)
                for m in r.data.get("markets", []):
                    markets.append({k: m.get(k) for k in ("ticker", "event_ticker", "floor_strike", "strike_type",
                                                          "open_time", "close_time", "result", "expiration_value")})
                cursor = r.data.get("cursor") or ""
                if not cursor:
                    break
            path.write_bytes(orjson.dumps(markets))
            print(f"{series}: {len(markets)} settled markets")
        # 2. near-the-money 1-minute candles over the last 50 minutes of each market
        todo = []
        for series, sym in SERIES.items():
            ms = orjson.loads(next(CACHE.glob(f"markets_{series}_{start // 86400}_*.json")).read_bytes())
            for m in ms:
                v, k = m.get("expiration_value"), m.get("floor_strike")
                if not v or not k or m.get("strike_type") != "greater" or m["result"] not in ("yes", "no"):
                    continue
                if abs(k / float(v) - 1) > BAND[sym]:
                    continue
                todo.append((series, m))
        ccache = _cache("candles")
        ccache.mkdir(exist_ok=True)
        missing = [(s, m) for s, m in todo if not (ccache / f"{m['ticker']}.json").exists()]
        print(f"candles: {len(todo)} markets, {len(missing)} to fetch")
        done = 0
        for series, m in missing:
            close = _ts(m["close_time"])
            try:
                r = await http.get(f"{KALSHI}/series/{series}/markets/{m['ticker']}/candlesticks",
                                   start_ts=close - 50 * 60, end_ts=close, period_interval=1)
            except Exception as e:  # noqa: BLE001
                print("skip", m["ticker"], e)
                continue
            rows = []
            for c in r.data.get("candlesticks", []):
                yb = (c.get("yes_bid") or {}).get("close_dollars")
                ya = (c.get("yes_ask") or {}).get("close_dollars")
                rows.append([c["end_period_ts"], float(yb) if yb else None, float(ya) if ya else None,
                             float(c.get("volume_fp") or 0)])
            (ccache / f"{m['ticker']}.json").write_bytes(orjson.dumps(rows))
            done += 1
            if done % 200 == 0:
                print(f"  {done}/{len(missing)}")
        # 3. Coinbase 1-minute spot, 4. DVOL hourly
        for sym in ("BTC", "ETH"):
            path = _cache(f"spot_{sym}_{start // 3600}_{end // 3600}.json")
            if not path.exists():
                rows: dict[int, float] = {}
                t = start - 3 * 3600
                while t < end:
                    t2 = min(end, t + 300 * 60)
                    r = await http.get(f"https://api.exchange.coinbase.com/products/{sym}-USD/candles", granularity=60,
                                       start=_iso(t),
                                       end=_iso(t2))
                    for c in r.data:
                        rows[int(c[0])] = float(c[4])
                    t = t2
                path.write_bytes(orjson.dumps(sorted(rows.items())))
            path = _cache(f"dvol_{sym}_{start // 3600}_{end // 3600}.json")
            if not path.exists():
                r = await http.get("https://www.deribit.com/api/v2/public/get_volatility_index_data", currency=sym,
                                   start_timestamp=(start - 7200) * 1000, end_timestamp=end * 1000, resolution=3600)
                path.write_bytes(orjson.dumps(r.data["result"]["data"]))
    finally:
        await http.aclose()


def _load_latest(prefix: str) -> Any:
    files = sorted(CACHE.glob(f"{prefix}*.json"), key=lambda p: p.stat().st_mtime)
    return orjson.loads(files[-1].read_bytes()) if files else None


def dataset() -> list[dict]:
    rows = []
    for series, sym in SERIES.items():
        markets = _load_latest(f"markets_{series}_") or []
        spot = dict(_load_latest(f"spot_{sym}_") or [])
        dvol = sorted((int(t // 1000), v / 100) for t, *_x, v in (_load_latest(f"dvol_{sym}_") or []))
        times = sorted(spot)
        # EWMA realized variance per minute (half-life 60 min), computed causally
        lam = 0.5 ** (1 / 60)
        rv: dict[int, float] = {}
        var = None
        for a, b in zip(times, times[1:]):
            if b - a == 60 and spot[a] > 0:
                r2 = math.log(spot[b] / spot[a]) ** 2
                var = r2 if var is None else lam * var + (1 - lam) * r2
            if var is not None:
                rv[b] = math.sqrt(var * 525_600)
        for m in markets:
            path = CACHE / "candles" / f"{m['ticker']}.json"
            if not path.exists():
                continue
            candles = {c[0]: c for c in orjson.loads(path.read_bytes())}
            close = _ts(m["close_time"])
            K = float(m["floor_strike"])
            y = 1.0 if m["result"] == "yes" else 0.0
            for h in HORIZONS_MIN:
                t = close - h * 60
                c = candles.get(t)
                s_t = spot.get(t - 60)  # last closed Coinbase minute before the quote
                if not c or s_t is None or c[1] is None or c[2] is None or not (0 < c[1] < c[2] < 1):
                    continue
                dv = next((v for ts, v in reversed(dvol) if ts <= t), None)
                r = rv.get(t - 60)
                T = h * 60 / YEAR_S
                p_dvol = digital_flat(s_t, K, dv, T) if dv else None
                p_rv = digital_flat(s_t, K, r, T) if r else None
                p_blend = sigmoid((logit(p_dvol) + logit(p_rv)) / 2) if p_dvol is not None and p_rv is not None else None
                rows.append({"sym": sym, "event": m["event_ticker"], "ticker": m["ticker"], "h": h, "strike": K,
                             "spot": s_t, "bid": c[1], "ask": c[2], "mid": (c[1] + c[2]) / 2, "y": y,
                             "dvol": dv, "rv": r, "p_dvol": p_dvol, "p_rv": p_rv, "p_blend": p_blend})
    return rows


MODELS = {"mid": "Kalshi mid (market)", "p_dvol": "DVOL implied vol (options proxy)",
          "p_rv": "Realized vol (1-min, EWMA 60 min)", "p_blend": "Blend of DVOL and realized"}


def strategy(rows: list[dict], model: str, thr: float) -> dict[str, Any]:
    """Buy 1 contract when the model beats the touch by thr after the Kalshi taker fee; one
    decision per market at the 30-minute and 15-minute marks; hold to settlement."""
    pnl = []
    for r in rows:
        p = r.get(model)
        if p is None or r["h"] not in (30, 15):
            continue
        ey = p - r["ask"] - fee_per_contract("kalshi", r["ask"])
        en = (1 - p) - (1 - r["bid"]) - fee_per_contract("kalshi", 1 - r["bid"])
        if max(ey, en) < thr:
            continue
        if ey >= en:
            pnl.append(r["y"] - r["ask"] - fee_per_contract("kalshi", r["ask"]))
        else:
            pnl.append((1 - r["y"]) - (1 - r["bid"]) - fee_per_contract("kalshi", 1 - r["bid"]))
    if not pnl:
        return {"trades": 0}
    rng = random.Random(0)
    boots = sorted(sum(rng.choice(pnl) for _ in pnl) / len(pnl) for _ in range(1000))
    return {"trades": len(pnl), "pnl_per_contract": round(sum(pnl) / len(pnl), 4), "total": round(sum(pnl), 2),
            "hit_rate": round(sum(1 for x in pnl if x > 0) / len(pnl), 3),
            "ci95": [round(boots[25], 4), round(boots[975], 4)]}


def analyse(rows: list[dict]) -> dict[str, Any]:
    out: dict[str, Any] = {"n_rows": len(rows), "n_markets": len({r["ticker"] for r in rows}),
                           "n_events": len({r["event"] for r in rows}), "horizons_min": list(HORIZONS_MIN),
                           "models": MODELS}
    if not rows:
        return out
    out["calibration"] = {}
    for key, sel in [("all", rows), *[(f"{h} min", [r for r in rows if r["h"] == h]) for h in HORIZONS_MIN],
                     *[(s, [r for r in rows if r["sym"] == s]) for s in SERIES.values()]]:
        paired = [r for r in sel if all(r.get(m) is not None for m in MODELS)]
        if not paired:
            continue
        out["calibration"][key] = {"n": len(paired), "markets": len({r["ticker"] for r in paired}),
                                   "base_rate": round(sum(r["y"] for r in paired) / len(paired), 4),
                                   "models": {m: _scores([r[m] for r in paired], [r["y"] for r in paired]) for m in MODELS}}
    out["strategy"] = {m: {str(t): strategy(rows, m, t) for t in (0.0, 0.02, 0.05)} for m in MODELS if m != "mid"}
    out["vol"] = {s: {"dvol_mean": round(sum(r["dvol"] for r in rows if r["sym"] == s and r["dvol"]) /
                                         max(1, sum(1 for r in rows if r["sym"] == s and r["dvol"])), 4),
                      "rv_mean": round(sum(r["rv"] for r in rows if r["sym"] == s and r["rv"]) /
                                       max(1, sum(1 for r in rows if r["sym"] == s and r["rv"])), 4)}
                  for s in SERIES.values()}
    # implied vol the market priced, from the mid at each row, vs what followed
    ivs = defaultdict(list)
    for r in rows:
        T = r["h"] * 60 / YEAR_S
        m = min(0.97, max(0.03, r["mid"]))
        x = math.log(r["spot"] / r["strike"])
        from statistics import NormalDist
        z = NormalDist().inv_cdf(m)
        if abs(z) > 0.15 and x * z > 0:
            ivs[r["sym"]].append(x / (z * math.sqrt(T)))
    out["market_implied_vol_median"] = {s: round(sorted(v)[len(v) // 2], 4) for s, v in ivs.items() if v}
    ts = sorted(_ts_close(r["event"]) for r in rows)
    out["period"] = {"from": _iso(ts[0] - 3600),
                     "to": _iso(ts[-1])} if ts else None
    return out


def _ts_close(event: str) -> int:
    # KXBTCD-26NOV0517 -> 2026-11-05 17:00 EST (UTC-5 after Nov 1 2026; EDT before)
    tag = event.split("-")[1]
    dt = datetime.strptime(tag, "%y%b%d%H")
    from zoneinfo import ZoneInfo
    return int(dt.replace(tzinfo=ZoneInfo("America/New_York")).timestamp())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7.0)
    ap.add_argument("--no-fetch", action="store_true")
    a = ap.parse_args()
    if not a.no_fetch:
        asyncio.run(fetch(a.days))
    rows = dataset()
    res = analyse(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(orjson.dumps(res, option=orjson.OPT_INDENT_2))
    print(orjson.dumps({k: v for k, v in res.items() if k in ("n_rows", "n_markets", "n_events", "period",
                                                             "vol", "market_implied_vol_median")}).decode())
    for k, v in res.get("calibration", {}).items():
        print(k, v["n"], {m: v["models"][m]["brier"] for m in MODELS})
    for m, s in res.get("strategy", {}).items():
        print(m, s)


if __name__ == "__main__":
    main()
