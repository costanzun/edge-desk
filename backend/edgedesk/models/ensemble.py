"""Market-ensemble model: logit pooling of the independent estimates we have for a contract.

Inputs (each optional): options-implied P, realized-vol P, the *other* venue's mid for the
same underlying and expiry interpolated at this strike (cross-venue, Polymarket tends to
lead Kalshi), and this venue's own mid. Weights are fixed and stated, not fitted, so the
ensemble cannot be over-tuned on the evaluation data; when a component is missing the
remaining weights are renormalised.
"""

from __future__ import annotations

from edgedesk.models.pricing import logit, sigmoid

DEFAULT_WEIGHTS = {"options": 0.40, "realized": 0.10, "cross": 0.25, "own": 0.25}


def pool(parts: dict[str, float | None], weights: dict[str, float] | None = None) -> float | None:
    w = weights or DEFAULT_WEIGHTS
    num = den = 0.0
    for k, p in parts.items():
        if p is None or k not in w:
            continue
        num += w[k] * logit(p)
        den += w[k]
    if den == 0:
        return None
    return sigmoid(num / den)


def interp_curve(points: list[tuple[float, float]], strike: float) -> float | None:
    """Linear interpolation of a P(above strike) curve; no extrapolation beyond 1 strike gap."""
    if len(points) < 2:
        return None
    pts = sorted(points)
    if strike < pts[0][0] or strike > pts[-1][0]:
        return None
    for (k0, p0), (k1, p1) in zip(pts, pts[1:]):
        if k0 <= strike <= k1:
            if k1 == k0:
                return p0
            w = (strike - k0) / (k1 - k0)
            return p0 * (1 - w) + p1 * w
    return None
