"""Capital tools: Kelly sizing with the model's error band, joint allocation across
correlated contracts, risk of ruin, and summary statistics with their caveats."""

from __future__ import annotations

import math
import random
from typing import Any

import numpy as np
from scipy.optimize import minimize

from edgedesk.models.options_implied import OptionsImplied
from edgedesk.models.pricing import YEAR_S, digital_smile


def kelly(p: float, price: float, fee: float = 0.0, band: float = 0.0, fraction: float = 0.25,
          bankroll: float = 10_000.0, cap: float | None = None) -> dict[str, Any]:
    """Binary contract bought at ``price`` (+fee per contract) that pays 1 with probability p.

    Full Kelly f* = (p - c) / (1 - c) with c = price + fee. We size on the conservative
    probability p - band, then take a fraction of it."""
    c = price + fee
    p_cons = p - band
    full = (p - c) / (1 - c) if 0 < c < 1 else 0.0
    cons = (p_cons - c) / (1 - c) if 0 < c < 1 else 0.0
    f = max(0.0, cons) * fraction
    stake = f * bankroll
    if cap is not None:
        stake = min(stake, cap)
    qty = int(stake // c) if c > 0 else 0
    growth = 0.0
    if f > 0:
        win, lose = (1 - c) / c, -1.0
        growth = p * math.log(1 + f * win) + (1 - p) * math.log(1 + f * lose)
    return {"cost_per_contract": round(c, 4), "edge": round(p - c, 4), "edge_conservative": round(p_cons - c, 4),
            "kelly_full": round(max(0.0, full), 4), "kelly_conservative": round(max(0.0, cons), 4),
            "fraction_used": round(f, 4), "stake": round(qty * c, 2), "contracts": qty,
            "expected_log_growth": round(growth, 6)}


def sample_terminal(model: OptionsImplied, sym: str, spot: float, expiry_ms: int, t_ns: int, n: int = 20_000,
                    seed: int = 0, short_vol: float | None = None) -> np.ndarray:
    """Draw S_T from the options-implied distribution by inverting P(S_T > K) on a strike grid."""
    T = (expiry_ms - t_ns / 1e6) / 1000 / YEAR_S
    vol_at, _ = model.vol_fn(sym, spot, T, short_vol=short_vol)
    sd = vol_at(spot) * math.sqrt(T)
    ks = spot * np.exp(np.linspace(-7 * sd, 7 * sd, 400))
    above = np.array([digital_smile(spot, float(k), T, vol_at) for k in ks])
    cdf = np.maximum.accumulate(1 - above)
    cdf = (cdf - cdf[0]) / max(1e-12, cdf[-1] - cdf[0])
    u = np.random.default_rng(seed).random(n)
    return np.interp(u, cdf, ks)


def joint_allocation(opps: list[dict], samples: np.ndarray, max_fraction: float = 0.5,
                     fraction: float = 0.25) -> dict[str, Any]:
    """Maximise E[log(1 + sum_i x_i r_i(S_T))] over the stakes x_i (fractions of bankroll).

    opps: [{"id", "strike", "side": "yes"|"no", "cost": price+fee, "p": model prob}]. All on the
    same underlying and expiry, so their payoffs are functions of one S_T: they are strongly
    correlated, and independent Kelly sizes would over-bet. Returns joint and independent sizes,
    both scaled by ``fraction`` (fractional Kelly)."""
    if not opps:
        return {"opps": [], "joint_total": 0.0, "independent_total": 0.0}
    R = np.empty((len(samples), len(opps)))
    for j, o in enumerate(opps):
        win = samples > o["strike"] if o["side"] == "yes" else samples <= o["strike"]
        R[:, j] = np.where(win, (1 - o["cost"]) / o["cost"], -1.0)

    def neg(x):
        w = 1 + R @ x
        if np.any(w <= 1e-9):
            return 1e6
        return -float(np.mean(np.log(w)))

    def grad(x):
        w = 1 + R @ x
        if np.any(w <= 1e-9):
            return np.zeros_like(x)
        return -np.mean(R / w[:, None], axis=0)

    x0 = np.full(len(opps), min(0.01, max_fraction / len(opps)))
    res = minimize(neg, x0, jac=grad, method="SLSQP", bounds=[(0.0, max_fraction)] * len(opps),
                   constraints=[{"type": "ineq", "fun": lambda x: max_fraction - np.sum(x)}],
                   options={"maxiter": 200, "ftol": 1e-10})
    x = np.clip(res.x, 0, None)
    indep = [max(0.0, (o["p"] - o["cost"]) / (1 - o["cost"])) for o in opps]
    out = []
    for o, xj, ij in zip(opps, x, indep):
        out.append({**o, "joint": round(float(xj) * fraction, 5), "independent": round(ij * fraction, 5)})
    return {"opps": out, "joint_total": round(float(np.sum(x)) * fraction, 5),
            "independent_total": round(sum(indep) * fraction, 5),
            "expected_log_growth": round(-neg(x), 6), "converged": bool(res.success)}


def risk_of_ruin(returns: list[float], n_trades: int = 500, paths: int = 5000, ruin: float = 0.5,
                 seed: int = 42) -> dict[str, Any]:
    """Bootstrap Monte Carlo: resample per-trade returns (as fractions of equity at entry) for
    ``n_trades`` trades; ruin = equity ever falls below ``ruin`` x start. Assumes trades are
    independent and the past distribution repeats: both optimistic, stated in the UI."""
    if not returns:
        return {"n_source_trades": 0}
    rng = random.Random(seed)
    finals, dds, ruined = [], [], 0
    for _ in range(paths):
        eq, peak, mdd, hit = 1.0, 1.0, 0.0, False
        for _ in range(n_trades):
            eq *= 1 + rng.choice(returns)
            peak = max(peak, eq)
            mdd = min(mdd, eq / peak - 1)
            if eq < ruin:
                hit = True
                break
        ruined += hit
        finals.append(eq)
        dds.append(mdd)
    finals.sort()
    dds.sort()
    q = lambda xs, p: xs[min(len(xs) - 1, int(p * len(xs)))]
    return {"n_source_trades": len(returns), "n_trades": n_trades, "paths": paths, "ruin_level": ruin,
            "p_ruin": round(ruined / paths, 4), "final_p5": round(q(finals, 0.05), 4),
            "final_p50": round(q(finals, 0.5), 4), "final_p95": round(q(finals, 0.95), 4),
            "max_dd_p50": round(q(dds, 0.5), 4), "max_dd_p5": round(q(dds, 0.05), 4)}


def stats(returns: list[float]) -> dict[str, Any]:
    if len(returns) < 2:
        return {"n": len(returns)}
    m = sum(returns) / len(returns)
    sd = math.sqrt(sum((r - m) ** 2 for r in returns) / (len(returns) - 1))
    return {"n": len(returns), "mean": round(m, 6), "sd": round(sd, 6),
            "sharpe_per_trade": round(m / sd, 4) if sd > 0 else None,
            "hit_rate": round(sum(1 for r in returns if r > 0) / len(returns), 4),
            "caveat": "Per-trade, not annualised: trades overlap in time and share underlyings, so they "
                      "are not independent and a daily Sharpe needs many more days of data."}
