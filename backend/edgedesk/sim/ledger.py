"""Double-entry ledger and the independent position fold used for reconciliation.

The ledger books every fill and settlement as balanced journal entries (cash, fees,
position cost, realized P&L) and tracks contract units per position account. The
``Portfolio`` is a second, independent fold over the same fill/settle events. The engine
reconciles the two continuously; any difference halts trading.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

TOL = 1e-6


class Unbalanced(Exception):
    pass


@dataclass
class Ledger:
    start_cash: float
    balances: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    units: dict[str, float] = field(default_factory=lambda: defaultdict(float))
    journal: list[tuple[int, str, list[tuple[str, float]]]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.post(0, "open", [("cash", self.start_cash), ("equity", -self.start_cash)])

    def post(self, t: int, memo: str, lines: list[tuple[str, float]]) -> None:
        """lines: (account, amount) with debits positive, credits negative; must sum to 0."""
        if abs(sum(a for _, a in lines)) > TOL:
            raise Unbalanced(f"{memo}: {lines}")
        for acct, amt in lines:
            self.balances[acct] += amt
        self.journal.append((t, memo, lines))

    def fill(self, t: int, cid: str, side: str, qty: int, px: float, fee: float) -> None:
        pos = f"pos:{cid}:{side}"
        cost = qty * px
        self.post(t, f"fill {cid} {side} {qty}@{px}", [(pos, cost), ("fees", fee), ("cash", -(cost + fee))])
        self.units[pos] += qty

    def settle(self, t: int, cid: str, side: str, payout_per: float) -> float:
        pos = f"pos:{cid}:{side}"
        qty = self.units.get(pos, 0.0)
        if qty == 0:
            return 0.0
        basis = self.balances[pos]
        payout = qty * payout_per
        self.post(t, f"settle {cid} {side}", [("cash", payout), (pos, -basis), ("pnl", basis - payout)])
        self.units[pos] = 0.0
        return payout - basis

    @property
    def cash(self) -> float:
        return self.balances["cash"]

    def position_units(self) -> dict[tuple[str, str], float]:
        out = {}
        for acct, u in self.units.items():
            if abs(u) > TOL:
                cid, side = acct.split(":", 1)[1].rsplit(":", 1)
                out[(cid, side)] = u
        return out


@dataclass
class Position:
    qty: int = 0
    cost: float = 0.0
    fees: float = 0.0


class Portfolio:
    """Positions and cash folded directly from fill and settle events (no journal)."""

    def __init__(self, start_cash: float) -> None:
        self.cash = start_cash
        self.pos: dict[tuple[str, str], Position] = {}
        self.realized = 0.0
        self.fees = 0.0

    def fill(self, cid: str, side: str, qty: int, px: float, fee: float) -> None:
        p = self.pos.setdefault((cid, side), Position())
        p.qty += qty
        p.cost += qty * px
        p.fees += fee
        self.cash -= qty * px + fee
        self.fees += fee

    def settle(self, cid: str, side: str, payout_per: float) -> float:
        p = self.pos.pop((cid, side), None)
        if not p:
            return 0.0
        pnl = p.qty * payout_per - p.cost
        self.cash += p.qty * payout_per
        self.realized += pnl
        return pnl

    def units(self) -> dict[tuple[str, str], float]:
        return {k: float(v.qty) for k, v in self.pos.items() if v.qty}


def reconcile(ledger: Ledger, pf: Portfolio) -> list[str]:
    """Differences between the ledger and the independent fold (empty == reconciled)."""
    breaks = []
    lu, pu = ledger.position_units(), pf.units()
    for k in sorted(set(lu) | set(pu)):
        if abs(lu.get(k, 0.0) - pu.get(k, 0.0)) > TOL:
            breaks.append(f"units {k[0]}:{k[1]} ledger={lu.get(k, 0.0)} fills={pu.get(k, 0.0)}")
    if abs(ledger.cash - pf.cash) > 1e-4:
        breaks.append(f"cash ledger={ledger.cash:.6f} fills={pf.cash:.6f}")
    if abs(ledger.balances["fees"] - pf.fees) > 1e-4:
        breaks.append(f"fees ledger={ledger.balances['fees']:.6f} fills={pf.fees:.6f}")
    return breaks
