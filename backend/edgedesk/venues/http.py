"""Polite, measured HTTP for public market-data endpoints.

One keep-alive client per host (connection reuse), a token bucket per host so we stay
well inside each venue's published limits, exponential backoff with jitter on 429/5xx
and network errors (honouring Retry-After), and a round-trip time on every response.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import orjson

log = logging.getLogger("edgedesk.http")

UA = "edge-desk/0.1 (paper-trading research; public data only)"

# Requests per second we allow ourselves per host: well under each venue's public limit.
DEFAULT_RATES = {
    "api.elections.kalshi.com": 6.0,   # Kalshi basic tier allows 20 reads/s
    "gamma-api.polymarket.com": 2.0,
    "clob.polymarket.com": 4.0,
    "www.deribit.com": 4.0,
    "api.exchange.coinbase.com": 3.0,
    "api.binance.com": 3.0,
}


@dataclass
class Bucket:
    rate: float
    capacity: float
    tokens: float = 0.0
    last: float = field(default_factory=time.monotonic)
    blocked_until: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def take(self) -> None:
        async with self.lock:
            while True:
                now = time.monotonic()
                if now < self.blocked_until:
                    await asyncio.sleep(self.blocked_until - now)
                    continue
                self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
                self.last = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)


@dataclass
class Response:
    status: int
    data: Any
    rtt_ms: float
    t_recv: int  # ns epoch
    attempts: int


class HttpError(Exception):
    def __init__(self, url: str, status: int | None, msg: str) -> None:
        super().__init__(f"{status} {url}: {msg}")
        self.status = status


class PoliteClient:
    def __init__(self, rates: dict[str, float] | None = None, timeout: float = 10.0,
                 max_attempts: int = 5) -> None:
        self._rates = {**DEFAULT_RATES, **(rates or {})}
        self._buckets: dict[str, Bucket] = {}
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._timeout = timeout
        self.max_attempts = max_attempts
        self.stats: dict[str, dict[str, int]] = {}

    def _bucket(self, host: str) -> Bucket:
        if host not in self._buckets:
            r = self._rates.get(host, 2.0)
            self._buckets[host] = Bucket(rate=r, capacity=max(1.0, r), tokens=1.0)
        return self._buckets[host]

    def _client(self, host: str) -> httpx.AsyncClient:
        if host not in self._clients:
            self._clients[host] = httpx.AsyncClient(
                timeout=self._timeout, headers={"User-Agent": UA, "Accept": "application/json"},
                limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
            )
        return self._clients[host]

    def _stat(self, host: str, key: str) -> None:
        self.stats.setdefault(host, {}).setdefault(key, 0)
        self.stats[host][key] += 1

    async def request(self, method: str, url: str, *, json: Any = None,
                      params: dict | None = None) -> Response:
        host = httpx.URL(url).host
        bucket = self._bucket(host)
        client = self._client(host)
        delay = 1.0
        last_err = ""
        status: int | None = None
        for attempt in range(1, self.max_attempts + 1):
            await bucket.take()
            t0 = time.perf_counter()
            try:
                r = await client.request(method, url, params=params, json=json)
                rtt = (time.perf_counter() - t0) * 1000
                t_recv = time.time_ns()
                status = r.status_code
                if r.status_code == 429 or r.status_code >= 500:
                    self._stat(host, str(r.status_code))
                    ra = r.headers.get("retry-after")
                    wait = float(ra) if ra and ra.replace(".", "", 1).isdigit() else delay
                    wait = min(60.0, wait) * (0.8 + 0.4 * random.random())
                    bucket.blocked_until = time.monotonic() + wait
                    last_err = f"HTTP {r.status_code}"
                    log.warning("%s %s -> %s, backing off %.1fs", method, url, r.status_code, wait)
                    delay = min(60.0, delay * 2)
                    continue
                if r.status_code >= 400:
                    self._stat(host, str(r.status_code))
                    raise HttpError(url, r.status_code, r.text[:200])
                self._stat(host, "ok")
                return Response(r.status_code, orjson.loads(r.content), rtt, t_recv, attempt)
            except (httpx.TransportError, orjson.JSONDecodeError) as e:
                self._stat(host, type(e).__name__)
                last_err = f"{type(e).__name__}: {e}"
                wait = delay * (0.8 + 0.4 * random.random())
                log.warning("%s %s failed (%s), retry in %.1fs", method, url, last_err, wait)
                await asyncio.sleep(wait)
                delay = min(60.0, delay * 2)
        raise HttpError(url, status, f"gave up after {self.max_attempts} attempts: {last_err}")

    async def get(self, url: str, **params: Any) -> Response:
        return await self.request("GET", url, params=params or None)

    async def post(self, url: str, json: Any) -> Response:
        return await self.request("POST", url, json=json)

    async def aclose(self) -> None:
        for c in self._clients.values():
            await c.aclose()
