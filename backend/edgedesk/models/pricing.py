"""Black-76 pricing and digital (binary) probabilities. Pure functions, no numpy, so the hot
path stays fast and bit-for-bit reproducible."""

from __future__ import annotations

import math

YEAR_S = 365.0 * 86400.0
SQRT2 = math.sqrt(2.0)


def ncdf(x: float) -> float:
    return 0.5 * math.erfc(-x / SQRT2)


def npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def black_call(F: float, K: float, sigma: float, T: float) -> float:
    """Undiscounted Black call price (rates ~0 over hours/days)."""
    if T <= 0 or sigma <= 0:
        return max(F - K, 0.0)
    sd = sigma * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * sd * sd) / sd
    return F * ncdf(d1) - K * ncdf(d1 - sd)


def digital_flat(F: float, K: float, sigma: float, T: float) -> float:
    """P(S_T > K) under a lognormal with constant vol (no smile)."""
    if T <= 0 or sigma <= 0:
        return 1.0 if F > K else 0.0
    sd = sigma * math.sqrt(T)
    return ncdf((math.log(F / K) - 0.5 * sd * sd) / sd)


def digital_smile(F: float, K: float, T: float, vol_at) -> float:
    """P(S_T > K) = -dC/dK (Breeden-Litzenberger, first derivative), with the smile.

    ``vol_at(K)`` returns the implied vol at strike K for maturity T. A central finite
    difference on the call price picks up the skew term that N(d2) alone misses.
    """
    if T <= 0:
        return 1.0 if F > K else 0.0
    h = K * 5e-4
    c_lo = black_call(F, K - h, vol_at(K - h), T)
    c_hi = black_call(F, K + h, vol_at(K + h), T)
    p = (c_lo - c_hi) / (2 * h)
    return min(1.0, max(0.0, p))


def logit(p: float, eps: float = 1e-4) -> float:
    p = min(1 - eps, max(eps, p))
    return math.log(p / (1 - p))


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))
