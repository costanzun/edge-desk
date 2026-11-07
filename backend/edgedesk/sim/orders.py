"""Order model and the explicit order state machine.

    NEW --> ACKED --> PARTIALLY_FILLED --> FILLED
     |        |              |
     |        +--------------+--> CANCELLED   (cancel request, kill switch)
     |        +--------------+--> EXPIRED     (IOC remainder, good-till-time ran out)
     +--> REJECTED                             (venue-side validation)

Any other transition is a bug: ``transition`` raises, and the engine halts trading.
"""

from __future__ import annotations

from dataclasses import dataclass, field

NEW, ACKED, PARTIAL, FILLED, CANCELLED, REJECTED, EXPIRED = (
    "new", "acked", "partially_filled", "filled", "cancelled", "rejected", "expired")
TERMINAL = {FILLED, CANCELLED, REJECTED, EXPIRED}

ALLOWED = {
    NEW: {ACKED, REJECTED, CANCELLED},
    ACKED: {PARTIAL, FILLED, CANCELLED, EXPIRED},
    PARTIAL: {PARTIAL, FILLED, CANCELLED, EXPIRED},
    FILLED: set(), CANCELLED: set(), REJECTED: set(), EXPIRED: set(),
}


class IllegalTransition(Exception):
    pass


@dataclass
class Order:
    oid: int
    key: str            # idempotency key: the same key never creates a second order
    venue: str
    cid: str
    side: str           # "yes" | "no"  (we only ever buy; selling YES == buying NO)
    limit: float        # max price per contract for the side bought
    qty: int
    tif: str            # "ioc" | "gtt"
    t_new: int
    expire_t: int | None = None
    maker: bool = False
    state: str = NEW
    filled: int = 0
    notional: float = 0.0
    fees: float = 0.0
    history: list[tuple[int, str]] = field(default_factory=list)
    reason: str = ""
    touch_arrival: float | None = None

    @property
    def open(self) -> bool:
        return self.state not in TERMINAL

    @property
    def remaining(self) -> int:
        return self.qty - self.filled

    @property
    def avg_px(self) -> float | None:
        return self.notional / self.filled if self.filled else None

    def transition(self, new: str, t: int) -> None:
        if new not in ALLOWED[self.state]:
            raise IllegalTransition(f"order {self.oid}: {self.state} -> {new}")
        self.state = new
        self.history.append((t, new))

    def as_dict(self) -> dict:
        return {"oid": self.oid, "key": self.key, "venue": self.venue, "cid": self.cid, "side": self.side,
                "limit": self.limit, "qty": self.qty, "tif": self.tif, "state": self.state,
                "filled": self.filled, "avg_px": self.avg_px, "fees": round(self.fees, 6),
                "t_new": self.t_new, "maker": self.maker, "reason": self.reason}
