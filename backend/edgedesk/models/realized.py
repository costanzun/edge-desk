"""Realized-volatility model: EWMA of 1-minute log returns of spot, lognormal, zero drift.

A deliberately simple cross-check on the options-implied number. It knows nothing about
the market's forward-looking view (events, weekends), only what spot has done lately.
"""

from __future__ import annotations

import math

from edgedesk.models.pricing import YEAR_S, digital_flat

MIN_RETURNS = 20


class RealizedVol:
    name = "realized"

    def __init__(self, halflife_min: float = 60.0, floor: float = 0.10) -> None:
        self.lam = 0.5 ** (1.0 / halflife_min)
        self.floor = floor
        self._minute: dict[str, int] = {}
        self._last_px: dict[str, float] = {}
        self._close: dict[str, float] = {}
        self._var: dict[str, float] = {}
        self._n: dict[str, int] = {}

    def on_spot(self, sym: str, mid: float, t_ns: int) -> None:
        m = t_ns // 60_000_000_000
        cur = self._minute.get(sym)
        if cur is None:
            self._minute[sym] = m
            self._close[sym] = mid
            return
        if m > cur:
            prev = self._last_px.get(sym)
            close = self._close[sym]
            if prev is not None and close > 0 and prev > 0:
                gap = m - cur  # minutes since the previous close; spread variance over the gap
                r2 = math.log(close / prev) ** 2 / max(1, gap)
                v = self._var.get(sym)
                self._var[sym] = r2 if v is None else self.lam * v + (1 - self.lam) * r2
                self._n[sym] = self._n.get(sym, 0) + 1
            self._last_px[sym] = close
            self._minute[sym] = m
        self._close[sym] = mid

    def sigma(self, sym: str) -> float | None:
        if self._n.get(sym, 0) < MIN_RETURNS:
            return None
        return max(self.floor, math.sqrt(self._var[sym] * 525_600))

    def fair(self, sym: str, spot: float, strike: float, expiry_ms: int, t_ns: int) -> float | None:
        s = self.sigma(sym)
        if s is None:
            return None
        T = (expiry_ms - t_ns / 1e6) / 1000 / YEAR_S
        if T <= 0:
            return None
        return digital_flat(spot, strike, s, T)
