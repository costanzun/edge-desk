"""Fill simulation against recorded book depth (pure functions).

Assumptions (stated, and shown in the UI):
- Taker orders walk the recorded book at the moment the order *arrives* at the venue
  (decision time + modelled latency). Levels better than or equal to the limit are taken.
- Depth haircut: we only take ``haircut`` of each displayed level (others are racing for
  it too); liquidity we took stays consumed until the venue's next book update.
- Resting (maker) orders fill only when the opposite side trades *through* our price
  (a strictly better quote appears), at our limit price. This ignores our queue position
  and so never assumes we were first in line.
"""

from __future__ import annotations

import math

EPS = 1e-9


def side_levels(side: str, bids: list[list[float]], asks: list[list[float]]) -> list[tuple[float, float]]:
    """Ask levels for buying ``side`` (best first). Buying NO at q hits a YES bid at 1-q."""
    if side == "yes":
        return [(p, q) for p, q in asks]
    return [(round(1.0 - p, 6), q) for p, q in bids]


def take(side: str, limit: float, qty: int, bids: list, asks: list, consumed: dict[tuple[str, float], float],
         haircut: float = 0.5) -> list[tuple[float, int]]:
    """Walk the book for a marketable order. Returns [(price, contracts)], mutates ``consumed``."""
    fills: list[tuple[float, int]] = []
    left = qty
    for px, sz in side_levels(side, bids, asks):
        if left <= 0 or px > limit + EPS:
            break
        key = (side, px)
        avail = math.floor(sz * haircut - consumed.get(key, 0.0) + EPS)
        if avail <= 0:
            continue
        q = min(left, avail)
        fills.append((px, q))
        consumed[key] = consumed.get(key, 0.0) + q
        left -= q
    return fills


def trade_through(side: str, limit: float, qty: int, bids: list, asks: list, haircut: float = 0.5) -> int:
    """Contracts a resting buy at ``limit`` would fill when the book trades through it."""
    through = sum(sz for px, sz in side_levels(side, bids, asks) if px < limit - EPS)
    return min(qty, math.floor(through * haircut + EPS))


def best(side: str, bids: list, asks: list) -> float | None:
    lv = side_levels(side, bids, asks)
    return lv[0][0] if lv else None


def mid(bids: list, asks: list, max_spread: float = 0.2) -> float | None:
    if not bids or not asks:
        return None
    b, a = bids[0][0], asks[0][0]
    if a - b > max_spread or a < b:
        return None
    return (a + b) / 2
