"""Live market-data recorder (read-only, public endpoints, no account, no keys).

    uv run python -m edgedesk.recorder            # records into ../data/raw, logs to ../logs

Feeds:
  spot      Coinbase BTC-USD/ETH-USD tickers and Binance BTCUSDT/ETHUSDT book tickers (2 s)
  deribit   index prices (5 s) and the option chain summary for expiries <= 10 days (30 s)
  kalshi    hourly/daily BTC and ETH "above" brackets (KXBTCD, KXETHD): top of book for every
            strike (10 s) and order-book depth for near-the-money strikes (15 s)
  poly      Polymarket "Bitcoin/Ethereum above ___" hourly and daily events: CLOB books (5 s)
  outcomes  settled Kalshi markets, resolved Polymarket markets and the Binance 1h candles
            that Polymarket resolves on (5 min)
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import orjson

from edgedesk.recorder.store import RawLog, compress_stale
from edgedesk.recorder.ws import WsFeeds
from edgedesk.venues.http import HttpError, PoliteClient

ROOT = Path(__file__).resolve().parents[3]
DATA = Path(os.environ.get("EDGE_DATA_DIR", ROOT / "data"))
LOGS = Path(os.environ.get("EDGE_LOG_DIR", ROOT / "logs"))

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
DERIBIT = "https://www.deribit.com/api/v2/public"
ET = ZoneInfo("America/New_York")

KALSHI_SERIES = {"KXBTCD": "BTC", "KXETHD": "ETH"}
POLY_NAMES = {"BTC": "bitcoin", "ETH": "ethereum"}

log = logging.getLogger("edgedesk.recorder")


def _f(x) -> float | None:
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


def _iso_ms(s: str | None) -> int | None:
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


class Recorder:
    def __init__(self) -> None:
        self.raw = RawLog(DATA / "raw")
        self.http = PoliteClient()
        self.state_path = DATA / "recorder_state.json"
        self.state = self._load_state()
        self.kalshi_events: dict[str, dict] = {}   # event_ticker -> meta
        self.kalshi_near: list[str] = []          # market tickers to fetch depth for
        self.poly_tokens: dict[str, dict] = {}    # yes token -> meta
        self.spot: dict[str, float] = {}
        self.health: dict[str, dict] = {}
        self.stop = asyncio.Event()
        self.ws = WsFeeds(self)

    # ------------------------------------------------------------------ state
    def _load_state(self) -> dict:
        try:
            return orjson.loads(self.state_path.read_bytes())
        except (OSError, orjson.JSONDecodeError):
            return {"kalshi_pending": {}, "poly_pending": {}, "kalshi_done": [], "poly_done": [],
                    "klines_done": []}

    def _save_state(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_bytes(orjson.dumps(self.state))
        os.replace(tmp, self.state_path)

    def _ok(self, feed: str, rtt: float | None = None) -> None:
        h = self.health.setdefault(feed, {"ok": 0, "err": 0})
        h["ok"] += 1
        h["last_ok"] = time.time()
        if rtt is not None:
            h["last_rtt_ms"] = round(rtt, 1)

    def _err(self, feed: str, e: Exception) -> None:
        h = self.health.setdefault(feed, {"ok": 0, "err": 0})
        h["err"] += 1
        h["last_err"] = f"{type(e).__name__}: {str(e)[:160]}"
        h["last_err_t"] = time.time()
        self.raw.append(feed, "error", {"error": h["last_err"],
                                        "status": getattr(e, "status", None)})
        log.warning("%s: %s", feed, h["last_err"])

    async def _every(self, period: float, name: str, fn) -> None:
        while not self.stop.is_set():
            t0 = time.monotonic()
            try:
                await fn()
            except Exception as e:  # noqa: BLE001 - a feed must never kill the recorder
                self._err(name, e)
            await asyncio.sleep(max(0.2, period - (time.monotonic() - t0)))

    # ------------------------------------------------------------------ spot
    async def spot_once(self) -> None:
        async def coinbase(sym: str) -> None:
            r = await self.http.get(f"https://api.exchange.coinbase.com/products/{sym}-USD/ticker")
            d = r.data
            bid, ask = _f(d.get("bid")), _f(d.get("ask"))
            self.raw.append("coinbase", "spot", {"sym": sym, "bid": bid, "ask": ask, "last": _f(d.get("price"))},
                            t_recv=r.t_recv, t_exch=_iso_ms((d.get("time") or "")[:26] + "Z"), rtt_ms=r.rtt_ms)
            if bid and ask:
                self.spot[sym] = (bid + ask) / 2
            self._ok("coinbase", r.rtt_ms)

        async def binance() -> None:
            r = await self.http.get("https://api.binance.com/api/v3/ticker/bookTicker",
                                    symbols='["BTCUSDT","ETHUSDT"]')
            for d in r.data:
                self.raw.append("binance", "spot", {"sym": d["symbol"][:3], "bid": _f(d["bidPrice"]),
                                                    "ask": _f(d["askPrice"]), "bid_sz": _f(d["bidQty"]),
                                                    "ask_sz": _f(d["askQty"])},
                                t_recv=r.t_recv, rtt_ms=r.rtt_ms)
            self._ok("binance", r.rtt_ms)

        res = await asyncio.gather(coinbase("BTC"), coinbase("ETH"), binance(), return_exceptions=True)
        for name, x in zip(["coinbase", "coinbase", "binance"], res):
            if isinstance(x, Exception):
                self._err(name, x)

    # ------------------------------------------------------------------ deribit
    async def deribit_index_once(self) -> None:
        for cur in ("btc", "eth"):
            r = await self.http.get(f"{DERIBIT}/get_index_price", index_name=f"{cur}_usd")
            res = r.data["result"]
            self.raw.append("deribit", "index", {"sym": cur.upper(), "price": res["index_price"]},
                            t_recv=r.t_recv, t_exch=r.data.get("usOut", 0) // 1000 or None, rtt_ms=r.rtt_ms)
            self._ok("deribit", r.rtt_ms)

    async def deribit_chain_once(self) -> None:
        horizon = (time.time() + 10 * 86400) * 1000
        for cur in ("BTC", "ETH"):
            r = await self.http.get(f"{DERIBIT}/get_book_summary_by_currency", currency=cur, kind="option")
            rows = []
            for o in r.data["result"]:
                name = o["instrument_name"]  # BTC-8NOV26-76000-C
                try:
                    _, exp, strike, cp = name.split("-")
                    exp_ms = int(datetime.strptime(exp, "%d%b%y").replace(
                        hour=8, tzinfo=timezone.utc).timestamp() * 1000)
                except ValueError:
                    continue
                if exp_ms > horizon:
                    continue
                rows.append([name, exp_ms, float(strike), cp, o.get("bid_price"), o.get("ask_price"),
                             o.get("mark_price"), o.get("mark_iv"), o.get("underlying_price"),
                             o.get("open_interest")])
            self.raw.append("deribit", "chain", {"sym": cur, "cols": ["name", "exp_ms", "strike", "cp", "bid",
                                                                      "ask", "mark", "mark_iv", "und",
                                                                      "oi"], "rows": rows},
                            t_recv=r.t_recv, t_exch=r.data.get("usOut", 0) // 1000 or None, rtt_ms=r.rtt_ms)
            self._ok("deribit", r.rtt_ms)

    # ------------------------------------------------------------------ kalshi
    async def kalshi_discover(self) -> None:
        found = {}
        for series, sym in KALSHI_SERIES.items():
            r = await self.http.get(f"{KALSHI}/events", series_ticker=series, status="open", limit=50)
            for e in r.data.get("events", []):
                close_ms = _iso_ms(e.get("strike_date"))
                if close_ms is None or close_ms - time.time() * 1000 > 8 * 86400 * 1000:
                    continue
                found[e["event_ticker"]] = {"sym": sym, "series": series, "close_ms": close_ms,
                                            "title": e.get("title")}
            self._ok("kalshi", r.rtt_ms)
        for t, meta in found.items():
            if t not in self.kalshi_events:
                self.raw.append("kalshi", "event", {"event": t, **meta})
            self.state["kalshi_pending"].setdefault(t, meta)
        self.kalshi_events = found
        self._save_state()

    async def kalshi_markets_once(self) -> None:
        near: list[tuple[float, str]] = []
        self._kcycle = getattr(self, "_kcycle", 0) + 1
        for ev, meta in list(self.kalshi_events.items()):
            left_h = (meta["close_ms"] / 1000 - time.time()) / 3600
            if left_h < 0 or (left_h > 30 and self._kcycle % 3):  # far expiries: every 30 s
                continue
            r = await self.http.get(f"{KALSHI}/markets", event_ticker=ev, limit=200)
            rows = []
            for m in r.data.get("markets", []):
                strike = _f(m.get("floor_strike"))
                s = self.spot.get(meta["sym"])
                if s and strike and abs(strike / s - 1) > 0.10:
                    continue  # deep in/out of the money: no information, lots of bytes
                rows.append([m["ticker"], strike, _f(m.get("cap_strike")), m.get("strike_type"),
                             _f(m.get("yes_bid_dollars")), _f(m.get("yes_ask_dollars")),
                             _f(m.get("yes_bid_size_fp")), _f(m.get("yes_ask_size_fp")),
                             _f(m.get("last_price_dollars")), _f(m.get("volume_fp")),
                             _f(m.get("open_interest_fp")), m.get("status")])
                if s and strike and m.get("status") == "active":
                    hrs = max(0.25, (meta["close_ms"] / 1000 - time.time()) / 3600)
                    band = 0.004 * hrs ** 0.5 * 3.0  # ~3 sigma at ~40% vol, scaled by sqrt(time)
                    dist = abs(strike / s - 1)
                    if dist < max(0.006, band):
                        near.append((dist, m["ticker"]))
            self.raw.append("kalshi", "markets", {"event": ev, "sym": meta["sym"], "close_ms": meta["close_ms"],
                                                  "cols": ["ticker", "strike", "cap", "type", "yes_bid",
                                                           "yes_ask", "yes_bid_sz", "yes_ask_sz", "last",
                                                           "volume", "oi", "status"], "rows": rows},
                            t_recv=r.t_recv, rtt_ms=r.rtt_ms)
            self._ok("kalshi", r.rtt_ms)
        near.sort()
        self.kalshi_near = [t for _, t in near[:30]]

    async def kalshi_books_once(self) -> None:
        for t in list(self.kalshi_near):
            r = await self.http.get(f"{KALSHI}/markets/{t}/orderbook", depth=10)
            ob = r.data.get("orderbook_fp") or r.data.get("orderbook") or {}
            yes = [[float(p), float(q)] for p, q in (ob.get("yes_dollars") or [])]
            no = [[float(p), float(q)] for p, q in (ob.get("no_dollars") or [])]
            self.raw.append("kalshi", "book", {"ticker": t, "yes": yes, "no": no},
                            t_recv=r.t_recv, rtt_ms=r.rtt_ms)
            self._ok("kalshi", r.rtt_ms)

    # ------------------------------------------------------------------ polymarket
    def _poly_slugs(self) -> list[tuple[str, str]]:
        now = datetime.now(ET)
        out = []
        for sym, name in POLY_NAMES.items():
            base = now.replace(minute=0, second=0, microsecond=0)
            for h in range(1, 5):  # the next four top-of-hour expiries
                t = base + timedelta(hours=h)
                out.append((f"{name}-above-on-{self._date_slug(t)}-{self._hour_slug(t)}-et", sym))
            for d in range(0, 2):
                day = now + timedelta(days=d)
                out.append((f"{name}-above-on-{self._date_slug(day)}", sym))
        return list(dict.fromkeys(out))

    @staticmethod
    def _date_slug(t: datetime) -> str:
        return f"{t.strftime('%B').lower()}-{t.day}-{t.year}"

    @staticmethod
    def _hour_slug(t: datetime) -> str:
        h = t.hour % 12 or 12
        return f"{h}{'am' if t.hour < 12 else 'pm'}"

    async def poly_discover(self) -> None:
        tokens = {}
        for slug, sym in self._poly_slugs():
            try:
                r = await self.http.get(f"{GAMMA}/events", slug=slug)
            except HttpError as e:
                self._err("polymarket", e)
                continue
            self._ok("polymarket", r.rtt_ms)
            if not r.data:
                continue
            e = r.data[0]
            end_ms = _iso_ms(e.get("endDate"))
            if not end_ms or e.get("closed"):
                continue
            mk = []
            for m in e.get("markets", []):
                try:
                    tok = orjson.loads(m.get("clobTokenIds") or "[]")
                    strike = float(str(m.get("groupItemTitle", "")).replace(",", "").replace("$", ""))
                except (ValueError, orjson.JSONDecodeError):
                    continue
                if len(tok) != 2 or m.get("closed"):
                    continue
                meta = {"slug": slug, "sym": sym, "strike": strike, "end_ms": end_ms,
                        "market_id": m.get("id"), "condition": m.get("conditionId"), "no_token": tok[1],
                        "fee": m.get("feeSchedule"), "tick": _f(m.get("orderPriceMinTickSize")),
                        "min_size": _f(m.get("orderMinSize"))}
                tokens[tok[0]] = meta
                mk.append({"yes_token": tok[0], **meta})
            if slug not in self.state["poly_pending"] and slug not in self.state["poly_done"]:
                self.raw.append("polymarket", "event", {"slug": slug, "sym": sym, "end_ms": end_ms,
                                                        "title": e.get("title"), "markets": mk})
                self.state["poly_pending"][slug] = {"sym": sym, "end_ms": end_ms}
        self.poly_tokens = tokens
        self._save_state()
        await self.ws.poly_sync()

    async def poly_books_once(self) -> None:
        now = time.time() * 1000
        toks = [t for t, m in self.poly_tokens.items() if m["end_ms"] > now]
        for i in range(0, len(toks), 40):
            chunk = toks[i:i + 40]
            r = await self.http.post(f"{CLOB}/books", [{"token_id": t} for t in chunk])
            books = []
            for b in r.data or []:
                bids = sorted(([float(x["price"]), float(x["size"])] for x in b.get("bids", [])), reverse=True)
                asks = sorted([float(x["price"]), float(x["size"])] for x in b.get("asks", []))
                books.append({"token": b.get("asset_id"), "ts": int(b.get("timestamp") or 0),
                              "bids": bids[:10], "asks": asks[:10]})
            self.raw.append("polymarket", "books", {"books": books}, t_recv=r.t_recv, rtt_ms=r.rtt_ms)
            self._ok("polymarket", r.rtt_ms)

    # ------------------------------------------------------------------ outcomes
    async def outcomes_once(self) -> None:
        now = time.time() * 1000
        for ev, meta in list(self.state["kalshi_pending"].items()):
            if meta["close_ms"] + 5 * 60_000 > now:
                continue
            r = await self.http.get(f"{KALSHI}/markets", event_ticker=ev, limit=200)
            ms = r.data.get("markets", [])
            res = [[m["ticker"], m.get("result"), _f(m.get("expiration_value")), _f(m.get("floor_strike"))]
                   for m in ms]
            if ms and all(x[1] in ("yes", "no") for x in res):
                self.raw.append("kalshi", "outcome", {"event": ev, "sym": meta["sym"], "close_ms": meta["close_ms"],
                                                      "cols": ["ticker", "result", "settle_value", "strike"],
                                                      "rows": res}, t_recv=r.t_recv, rtt_ms=r.rtt_ms)
                self.state["kalshi_pending"].pop(ev)
                self.state["kalshi_done"].append(ev)
            elif now - meta["close_ms"] > 3 * 86400_000:
                self.state["kalshi_pending"].pop(ev)
        for slug, meta in list(self.state["poly_pending"].items()):
            if meta["end_ms"] + 5 * 60_000 > now:
                continue
            await self._kline(meta["sym"], meta["end_ms"])
            r = await self.http.get(f"{GAMMA}/events", slug=slug)
            if not r.data:
                continue
            e = r.data[0]
            rows = []
            for m in e.get("markets", []):
                try:
                    prices = [float(p) for p in orjson.loads(m.get("outcomePrices") or "[]")]
                    strike = float(str(m.get("groupItemTitle", "")).replace(",", "").replace("$", ""))
                except (ValueError, orjson.JSONDecodeError):
                    continue
                rows.append([m.get("id"), strike, prices[0] if prices else None, bool(m.get("closed")),
                             m.get("umaResolutionStatus")])
            resolved = rows and all(r_[3] and r_[2] in (0.0, 1.0) for r_ in rows)
            if resolved:
                self.raw.append("polymarket", "outcome", {"slug": slug, "sym": meta["sym"], "end_ms": meta["end_ms"],
                                                          "cols": ["market_id", "strike", "yes_price", "closed",
                                                                   "uma"], "rows": rows},
                                t_recv=r.t_recv, rtt_ms=r.rtt_ms)
                self.state["poly_pending"].pop(slug)
                self.state["poly_done"].append(slug)
            elif now - meta["end_ms"] > 3 * 86400_000:
                self.state["poly_pending"].pop(slug)
        self._save_state()

    async def _kline(self, sym: str, end_ms: int) -> None:
        key = f"{sym}:{end_ms}"
        if key in self.state["klines_done"]:
            return
        r = await self.http.get("https://api.binance.com/api/v3/klines", symbol=f"{sym}USDT", interval="1h",
                                startTime=end_ms - 2 * 3600_000, endTime=end_ms + 3600_000)
        self.raw.append("binance", "kline_1h", {"sym": sym, "end_ms": end_ms,
                                                "rows": [[k[0], float(k[1]), float(k[4]), k[6]] for k in r.data]},
                        t_recv=r.t_recv, rtt_ms=r.rtt_ms)
        self.state["klines_done"].append(key)

    # ------------------------------------------------------------------ status
    async def status_once(self) -> None:
        status = {"t": time.time(), "seq": self.raw.seq, "written": self.raw.written, "pid": os.getpid(),
                  "kalshi_events": len(self.kalshi_events), "kalshi_near": len(self.kalshi_near),
                  "poly_tokens": len(self.poly_tokens), "health": self.health, "http": self.http.stats,
                  "pending": {"kalshi": len(self.state["kalshi_pending"]),
                              "poly": len(self.state["poly_pending"])},
                  "resolved": {"kalshi": len(self.state["kalshi_done"]), "poly": len(self.state["poly_done"])}}
        tmp = LOGS / "recorder_status.json.tmp"
        tmp.write_bytes(orjson.dumps(status, option=orjson.OPT_INDENT_2))
        os.replace(tmp, LOGS / "recorder_status.json")
        log.info("seq=%s written=%s kalshi_ev=%s near=%s poly_tok=%s resolved=%s", self.raw.seq,
                 self.raw.written, len(self.kalshi_events), len(self.kalshi_near), len(self.poly_tokens),
                 status["resolved"])

    async def run(self) -> None:
        compress_stale(DATA / "raw")
        await self.spot_once()
        await self.kalshi_discover()
        await self.poly_discover()
        tasks = [
            self._every(5.0, "spot", self.spot_once),
            self._every(5.0, "deribit", self.deribit_index_once),
            self._every(30.0, "deribit", self.deribit_chain_once),
            self._every(120.0, "kalshi", self.kalshi_discover),
            self._every(10.0, "kalshi", self.kalshi_markets_once),
            self._every(15.0, "kalshi", self.kalshi_books_once),
            self._every(120.0, "polymarket", self.poly_discover),
            self._every(15.0, "polymarket", self.poly_books_once),
            self._every(300.0, "outcomes", self.outcomes_once),
            self._every(60.0, "status", self.status_once),
            *self.ws.tasks(self.stop),
        ]
        running = [asyncio.create_task(t) for t in tasks]
        try:
            await asyncio.gather(*running)
        finally:
            for t in running:
                t.cancel()
            await asyncio.gather(*running, return_exceptions=True)


def main() -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.FileHandler(LOGS / "recorder.log"), logging.StreamHandler(sys.stdout)],
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    (LOGS / "recorder.pid").write_text(str(os.getpid()))
    rec = Recorder()
    loop = asyncio.new_event_loop()
    main_task = loop.create_task(rec.run())
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, lambda: (log.info("stopping"), rec.stop.set(), main_task.cancel()))
    log.info("recorder starting, data=%s, last seq=%s", DATA, rec.raw.seq)
    try:
        loop.run_until_complete(main_task)
    except asyncio.CancelledError:
        pass
    finally:
        loop.run_until_complete(rec.http.aclose())
        rec.raw.close()
        log.info("stopped at seq=%s", rec.raw.seq)


if __name__ == "__main__":
    main()
