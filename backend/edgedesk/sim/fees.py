"""Venue fee schedules (as published; see docs/fees.md for sources).

Kalshi (docs.kalshi.com get-series + fee_rounding; KXBTCD/KXETHD are fee_type "quadratic",
fee_multiplier 1, which charges takers only):
    taker fee = 0.07 * C * P * (1 - P), summed over the order's fills, and a retail account is
                debited ceil_to_cent of that total (per-fill micro-dollar rounding with a
                per-order rounding accumulator nets out to the order-level cent ceiling)
    maker fee = 0 on "quadratic" series (0.0175 * C * P * (1 - P) on "..._with_maker_fees")
Polymarket (docs.polymarket.com/trading/fees; crypto markets feeSchedule
{"rate": 0.07, "exponent": 1, "takerOnly": true}):
    taker fee = C * rate * (P * (1 - P)) ** exponent, in USDC, rounded to 5 decimals;
    makers pay nothing (and get a rebate we conservatively ignore)
"""

from __future__ import annotations

import math

KALSHI_TAKER = 0.07
KALSHI_MAKER = 0.0175


def _ceil_cent(x: float) -> float:
    # tolerate float noise just above an exact cent (e.g. 0.07 * 100 * 0.25 = 1.7500000000000002)
    return math.ceil(round(x * 100, 6)) / 100


def kalshi_fee(contracts: float, price: float, maker: bool = False, multiplier: float = 1.0,
               maker_fees: bool = False) -> float:
    if contracts <= 0 or (maker and not maker_fees):
        return 0.0
    k = (KALSHI_MAKER if maker else KALSHI_TAKER) * multiplier
    return _ceil_cent(k * contracts * price * (1 - price))


def polymarket_fee(contracts: float, price: float, maker: bool = False, rate: float | None = 0.07,
                   exponent: float | None = 1.0) -> float:
    if contracts <= 0 or maker or not rate:
        return 0.0
    fee = contracts * rate * (price * (1 - price)) ** (exponent or 1.0)
    fee = round(fee, 5)
    return fee if fee >= 0.00001 else 0.0


def fee(venue: str, contracts: float, price: float, maker: bool = False, contract: dict | None = None) -> float:
    if venue == "kalshi":
        return kalshi_fee(contracts, price, maker)
    if venue == "polymarket":
        c = contract or {}
        return polymarket_fee(contracts, price, maker, c.get("fee_rate", 0.07), c.get("fee_exp", 1.0))
    raise ValueError(f"unknown venue {venue}")


def fee_per_contract(venue: str, price: float, maker: bool = False, contract: dict | None = None) -> float:
    """Marginal fee estimate per contract (no rounding), used for edge thresholds."""
    if venue == "kalshi":
        return 0.0 if maker else KALSHI_TAKER * price * (1 - price)
    c = contract or {}
    if maker:
        return 0.0
    return (c.get("fee_rate") or 0.07) * (price * (1 - price)) ** (c.get("fee_exp") or 1.0)


def kalshi_order_fee(fills: list[tuple[float, float]], maker: bool = False) -> float:
    """Fee for one order executed as several fills [(contracts, price), ...]: the exact fees
    are summed and the account is debited the total rounded up to the cent."""
    if maker:
        return 0.0
    return _ceil_cent(sum(KALSHI_TAKER * q * p * (1 - p) for q, p in fills))
