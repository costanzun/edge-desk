"""Pre-trade risk checks. Every order request passes through ``RiskEngine.check`` and the
full list of check results is logged as a RISK event, accepted or not."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class RiskLimits:
    max_cost_per_market: float = 250.0        # $ at cost, per contract (both sides)
    max_cost_per_expiry: float = 750.0        # $ per underlying + expiry (strikes are correlated)
    max_cost_per_underlying: float = 1500.0   # $ per BTC / ETH
    max_gross: float = 3000.0                 # $ total open cost incl. orders in flight
    max_open_orders: int = 8
    daily_loss_limit: float = 300.0           # $ (realized + fees + mark-to-market); breach halts
    max_book_age_s: float = 30.0              # Kalshi REST books refresh every 10-15 s
    max_spot_age_s: float = 10.0
    max_chain_age_s: float = 120.0
    min_price: float = 0.03
    max_price: float = 0.97
    max_edge: float = 0.30                    # "too good to be true": usually bad data
    max_limit_vs_fair: float = 0.25

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class OrderRequest:
    venue: str
    cid: str
    sym: str
    expiry_ms: int
    side: str
    limit: float
    qty: int
    fair: float
    edge: float


@dataclass
class RiskContext:
    t: int
    halted: bool
    halt_reason: str
    book_age_s: float
    spot_age_s: float
    chain_age_s: float
    feed_ok: bool
    feed_reason: str
    open_orders: int
    cost_market: float
    cost_expiry: float
    cost_underlying: float
    gross: float
    day_pnl: float
    extra: dict = field(default_factory=dict)


class RiskEngine:
    def __init__(self, limits: RiskLimits | None = None) -> None:
        self.limits = limits or RiskLimits()

    def check(self, req: OrderRequest, ctx: RiskContext) -> tuple[bool, list[dict]]:
        L = self.limits
        cost = req.limit * req.qty
        checks = [
            ("not_halted", not ctx.halted, ctx.halt_reason or "trading enabled"),
            ("feed_healthy", ctx.feed_ok, ctx.feed_reason or "ok"),
            ("book_fresh", ctx.book_age_s <= L.max_book_age_s, f"book age {ctx.book_age_s:.1f}s"),
            ("spot_fresh", ctx.spot_age_s <= L.max_spot_age_s, f"spot age {ctx.spot_age_s:.1f}s"),
            ("chain_fresh", ctx.chain_age_s <= L.max_chain_age_s, f"chain age {ctx.chain_age_s:.0f}s"),
            ("price_band", L.min_price <= req.limit <= L.max_price, f"limit {req.limit:.3f}"),
            ("limit_near_fair", abs(req.limit - (req.fair if req.side == "yes" else 1 - req.fair))
             <= L.max_limit_vs_fair, "limit vs fair"),
            ("edge_sane", req.edge <= L.max_edge, f"edge {req.edge:.3f}"),
            ("qty_positive", req.qty > 0, f"qty {req.qty}"),
            ("open_orders", ctx.open_orders < L.max_open_orders, f"{ctx.open_orders} open"),
            ("max_per_market", ctx.cost_market + cost <= L.max_cost_per_market,
             f"${ctx.cost_market + cost:.0f} / {L.max_cost_per_market:.0f}"),
            ("max_per_expiry", ctx.cost_expiry + cost <= L.max_cost_per_expiry,
             f"${ctx.cost_expiry + cost:.0f} / {L.max_cost_per_expiry:.0f}"),
            ("max_per_underlying", ctx.cost_underlying + cost <= L.max_cost_per_underlying,
             f"${ctx.cost_underlying + cost:.0f} / {L.max_cost_per_underlying:.0f}"),
            ("max_gross", ctx.gross + cost <= L.max_gross, f"${ctx.gross + cost:.0f} / {L.max_gross:.0f}"),
            ("daily_loss", ctx.day_pnl > -L.daily_loss_limit, f"day P&L ${ctx.day_pnl:.2f}"),
        ]
        out = [{"check": n, "ok": bool(ok), "detail": d} for n, ok, d in checks]
        return all(c["ok"] for c in out), out

    def headroom(self, req_cost_per: float, ctx: RiskContext) -> int:
        """Max contracts at ``req_cost_per`` that fit every notional cap (for sizing)."""
        L = self.limits
        room = min(L.max_cost_per_market - ctx.cost_market, L.max_cost_per_expiry - ctx.cost_expiry,
                   L.max_cost_per_underlying - ctx.cost_underlying, L.max_gross - ctx.gross)
        if req_cost_per <= 0 or room <= 0:
            return 0
        return int(room // req_cost_per)
