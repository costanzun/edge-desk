"""Public WebSocket feeds (no auth): Polymarket market channel, Deribit price index,
Coinbase ticker, Binance book ticker.

Each feed reconnects with exponential backoff and jitter. High-rate spot streams are
conflated to at most one record per symbol per 250 ms (the latest message wins and keeps
its own receive time), so the log stays small without losing the information we use.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

import orjson
import websockets

log = logging.getLogger("edgedesk.ws")


def _iso_ms(s: str) -> int | None:
    try:
        return int(datetime.fromisoformat(s[:26].rstrip("Z") + "+00:00").timestamp() * 1000)
    except ValueError:
        return None

POLY_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
DERIBIT_WS = "wss://www.deribit.com/ws/api/v2"
COINBASE_WS = "wss://ws-feed.exchange.coinbase.com"
BINANCE_WS = "wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker"


async def reconnecting(name: str, stop: asyncio.Event, session: Callable[[], Awaitable[None]],
                       on_error: Callable[[str, Exception], None]) -> None:
    delay = 1.0
    while not stop.is_set():
        t0 = time.monotonic()
        try:
            await session()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - reconnect on anything
            on_error(name, e)
        if time.monotonic() - t0 > 60:
            delay = 1.0  # the session was healthy for a while: reset backoff
        wait = delay * (0.8 + 0.4 * random.random())
        log.info("%s: reconnecting in %.1fs", name, wait)
        await asyncio.sleep(wait)
        delay = min(60.0, delay * 2)


class Conflator:
    """Keeps the latest message per key and flushes changed ones every ``period`` seconds."""

    def __init__(self, period: float, emit: Callable[[str, dict, int], None]) -> None:
        self.period = period
        self.emit = emit
        self.latest: dict[str, tuple[dict, int]] = {}
        self.sent: dict[str, Any] = {}

    def put(self, key: str, data: dict, t_recv: int) -> None:
        self.latest[key] = (data, t_recv)

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await asyncio.sleep(self.period)
            for k, (d, t) in list(self.latest.items()):
                sig = (d.get("bid"), d.get("ask"))
                if self.sent.get(k) != sig:
                    self.sent[k] = sig
                    self.emit(k, d, t)


class WsFeeds:
    def __init__(self, rec) -> None:  # rec: Recorder (avoid import cycle)
        self.rec = rec
        self.poly_subscribed: set[str] = set()
        self._poly_ws = None
        self.spot = Conflator(0.25, self._emit_spot)
        self.poly_books: dict[str, tuple[dict[float, float], dict[float, float]]] = {}
        self._poly_dirty: dict[str, tuple[int | None, int]] = {}
        self._poly_sent: dict[str, tuple] = {}

    def _emit_spot(self, key: str, d: dict, t_recv: int) -> None:
        src = key.split(":")[0]
        self.rec.raw.append(src, "spot", {k: v for k, v in d.items() if k != "t_exch"},
                            t_recv=t_recv, t_exch=d.get("t_exch"))
        if src == "coinbase" and d.get("bid") and d.get("ask"):
            self.rec.spot[d["sym"]] = (d["bid"] + d["ask"]) / 2

    # ------------------------------------------------------------------ polymarket
    async def poly_session(self) -> None:
        async with websockets.connect(POLY_WS, ping_interval=None, max_size=2**23, open_timeout=15) as ws:
            self._poly_ws = ws
            self.poly_subscribed = set()
            await self.poly_sync()
            pinger = asyncio.create_task(self._poly_ping(ws))
            try:
                async for msg in ws:
                    t_recv = time.time_ns()
                    if msg == "PONG":
                        continue
                    self._poly_msg(orjson.loads(msg), t_recv)
            finally:
                pinger.cancel()
                self._poly_ws = None

    async def _poly_ping(self, ws) -> None:
        while True:
            await asyncio.sleep(10)
            await ws.send("PING")

    async def poly_sync(self) -> None:
        """Subscribe to tokens discovered since the last sync (called after each discovery)."""
        ws = self._poly_ws
        if ws is None:
            return
        want = set(self.rec.poly_tokens)
        new = sorted(want - self.poly_subscribed)
        if not new:
            return
        if not self.poly_subscribed:
            await ws.send(orjson.dumps({"assets_ids": new, "type": "market"}).decode())
        else:
            await ws.send(orjson.dumps({"assets_ids": new, "operation": "subscribe"}).decode())
        self.poly_subscribed |= set(new)
        self.rec._ok("polymarket_ws")

    def _poly_msg(self, m: Any, t_recv: int) -> None:
        """Maintain each YES token's full book from snapshots + level changes; the recorder
        writes a conflated top-5 snapshot (``ws_top``) only when the top 5 levels change."""
        if isinstance(m, list):
            for x in m:
                self._poly_msg(x, t_recv)
            return
        if not isinstance(m, dict):
            return
        et = m.get("event_type")
        yes = self.rec.poly_tokens
        ts = int(m.get("timestamp") or 0) or None
        if et == "book":
            tok = m.get("asset_id")
            if tok not in yes:
                return
            self.poly_books[tok] = ({float(x["price"]): float(x["size"]) for x in m.get("bids", [])},
                                    {float(x["price"]): float(x["size"]) for x in m.get("asks", [])})
            self._poly_dirty[tok] = (ts, t_recv)
        elif et == "price_change":
            for c in m.get("price_changes", []):
                tok = c.get("asset_id")
                if tok not in yes or tok not in self.poly_books:
                    continue
                side = self.poly_books[tok][0 if c["side"] == "BUY" else 1]
                px, sz = float(c["price"]), float(c["size"])
                if sz <= 0:
                    side.pop(px, None)
                else:
                    side[px] = sz
                self._poly_dirty[tok] = (ts, t_recv)
        elif et == "last_trade_price":
            tok = m.get("asset_id")
            if tok in yes:
                self.rec.raw.append("polymarket", "ws_trade", {"token": tok, "price": float(m["price"]),
                                                               "size": float(m.get("size") or 0),
                                                               "side": m.get("side"), "ts": ts},
                                    t_recv=t_recv, t_exch=ts)
        self.rec._ok("polymarket_ws")

    async def poly_flush(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await asyncio.sleep(0.25)
            dirty, self._poly_dirty = self._poly_dirty, {}
            for tok, (ts, t_recv) in dirty.items():
                b, a = self.poly_books.get(tok, ({}, {}))
                bids = sorted(b.items(), reverse=True)[:5]
                asks = sorted(a.items())[:5]
                key = (tuple(bids), tuple(asks))
                if self._poly_sent.get(tok) == key:
                    continue
                self._poly_sent[tok] = key
                self.rec.raw.append("polymarket", "ws_top", {"token": tok, "ts": ts,
                                                             "bids": [list(x) for x in bids],
                                                             "asks": [list(x) for x in asks]},
                                    t_recv=t_recv, t_exch=ts)

    # ------------------------------------------------------------------ deribit
    async def deribit_session(self) -> None:
        async with websockets.connect(DERIBIT_WS, ping_interval=None, open_timeout=15) as ws:
            await ws.send(orjson.dumps({"jsonrpc": "2.0", "id": 1, "method": "public/set_heartbeat",
                                        "params": {"interval": 30}}).decode())
            await ws.send(orjson.dumps({"jsonrpc": "2.0", "id": 2, "method": "public/subscribe", "params": {
                "channels": ["deribit_price_index.btc_usd", "deribit_price_index.eth_usd"]}}).decode())
            async for msg in ws:
                t_recv = time.time_ns()
                m = orjson.loads(msg)
                p = m.get("params") or {}
                if p.get("type") == "test_request":
                    await ws.send(orjson.dumps({"jsonrpc": "2.0", "id": 3, "method": "public/test",
                                                "params": {}}).decode())
                    continue
                d = p.get("data")
                if p.get("channel", "").startswith("deribit_price_index") and d:
                    sym = d["index_name"].split("_")[0].upper()
                    self.rec.raw.append("deribit", "index", {"sym": sym, "price": d["price"], "ws": True},
                                        t_recv=t_recv, t_exch=d.get("timestamp"))
                    self.rec._ok("deribit_ws")
                elif "error" in m:
                    raise RuntimeError(f"deribit error {m['error']}")

    # ------------------------------------------------------------------ spot
    async def coinbase_session(self) -> None:
        async with websockets.connect(COINBASE_WS, open_timeout=15, max_size=2**22) as ws:
            await ws.send(orjson.dumps({"type": "subscribe", "product_ids": ["BTC-USD", "ETH-USD"],
                                        "channels": ["ticker"]}).decode())
            async for msg in ws:
                t_recv = time.time_ns()
                m = orjson.loads(msg)
                if m.get("type") != "ticker":
                    if m.get("type") == "error":
                        raise RuntimeError(m.get("message"))
                    continue
                sym = m["product_id"].split("-")[0]
                t_exch = _iso_ms(m["time"]) if m.get("time") else None
                self.spot.put(f"coinbase:{sym}", {"sym": sym, "bid": float(m["best_bid"]),
                                                  "ask": float(m["best_ask"]), "last": float(m["price"]),
                                                  "ws": True, "t_exch": t_exch}, t_recv)
                self.rec._ok("coinbase_ws")

    async def binance_session(self) -> None:
        async with websockets.connect(BINANCE_WS, open_timeout=15) as ws:
            async for msg in ws:
                t_recv = time.time_ns()
                m = orjson.loads(msg).get("data") or {}
                if "s" not in m:
                    continue
                sym = m["s"][:3]
                self.spot.put(f"binance:{sym}", {"sym": sym, "bid": float(m["b"]), "ask": float(m["a"]),
                                                 "bid_sz": float(m["B"]), "ask_sz": float(m["A"]), "ws": True},
                              t_recv)
                self.rec._ok("binance_ws")

    def tasks(self, stop: asyncio.Event) -> list[Awaitable[None]]:
        err = self.rec._err
        return [
            reconnecting("polymarket_ws", stop, self.poly_session, err),
            reconnecting("deribit_ws", stop, self.deribit_session, err),
            reconnecting("coinbase_ws", stop, self.coinbase_session, err),
            reconnecting("binance_ws", stop, self.binance_session, err),
            self.spot.run(stop),
            self.poly_flush(stop),
        ]
