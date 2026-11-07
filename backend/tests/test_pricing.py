import math

import pytest

from edgedesk.models.ensemble import interp_curve, pool
from edgedesk.models.options_implied import OptionsImplied, build_smiles
from edgedesk.models.pricing import YEAR_S, black_call, digital_flat, digital_smile, ncdf
from edgedesk.models.realized import RealizedVol


def test_digital_matches_n_d2_for_flat_vol():
    F, K, s, T = 76000.0, 77000.0, 0.5, 2 / 365
    d2 = (math.log(F / K) - 0.5 * s * s * T) / (s * math.sqrt(T))
    assert digital_flat(F, K, s, T) == pytest.approx(ncdf(d2), abs=1e-12)
    assert digital_smile(F, K, T, lambda k: s) == pytest.approx(ncdf(d2), abs=2e-5)


def test_digital_is_minus_dC_dK():
    F, T = 100.0, 0.1
    vol = lambda k: 0.4 + 0.1 * math.log(k / F) ** 2 - 0.05 * math.log(k / F)  # skewed smile
    K, h = 105.0, 1e-3
    fd = (black_call(F, K - h, vol(K - h), T) - black_call(F, K + h, vol(K + h), T)) / (2 * h)
    assert digital_smile(F, K, T, vol) == pytest.approx(fd, abs=1e-4)


def test_digital_monotone_and_bounded():
    ps = [digital_flat(100, k, 0.6, 0.05) for k in range(80, 121, 5)]
    assert all(0 <= p <= 1 for p in ps)
    assert all(a > b for a, b in zip(ps, ps[1:]))


def _flat_chain(S, vol, t_ms):
    rows = []
    for d in (1, 2, 3):
        exp = t_ms + d * 86_400_000
        for K in range(int(S * 0.8), int(S * 1.2), int(S * 0.02)):
            for cp in ("C", "P"):
                rows.append([exp, float(K), cp, vol, S, None, None, None])
    return rows


def test_surface_recovers_flat_vol_and_probability():
    t_ms = 1_794_049_200_000
    m = OptionsImplied()
    m.on_chain("BTC", _flat_chain(76000.0, 0.45, t_ms), t_ms * 1_000_000)
    assert len(m.smiles["BTC"]) == 3
    for exp_h in (1, 30, 60):  # below, between and inside the expiries
        exp = t_ms + exp_h * 3_600_000
        f = m.fair("BTC", 76000.0, 77000.0, exp, t_ms * 1_000_000)
        T = exp_h * 3600 / YEAR_S
        assert f.sigma == pytest.approx(0.45, rel=1e-6)
        assert f.p == pytest.approx(digital_flat(76000.0, 77000.0, 0.45, T), abs=1e-4)
        assert f.band > 0
    assert m.fair("BTC", 76000.0, 77000.0, t_ms + 3_600_000, t_ms * 1_000_000).extrapolated


def test_hybrid_uses_short_vol_below_front_expiry():
    t_ms = 1_794_049_200_000
    m = OptionsImplied()
    m.on_chain("BTC", _flat_chain(76000.0, 0.45, t_ms), t_ms * 1_000_000)
    exp = t_ms + 1_800_000
    plain = m.fair("BTC", 76000.0, 76500.0, exp, t_ms * 1_000_000)
    hybrid = m.fair("BTC", 76000.0, 76500.0, exp, t_ms * 1_000_000, short_vol=0.10)
    assert hybrid.p < plain.p  # lower vol -> less chance to rally 0.65% in 30 minutes


def test_smiles_skip_nearly_expired():
    t_ms = 1_794_049_200_000
    rows = [[t_ms + 5 * 60_000, float(K), "C", 0.5, 100.0, None, None, None] for K in range(100, 130, 5)]
    assert build_smiles(rows, t_ms) == []


def test_realized_vol_estimates_known_vol():
    import random
    rng = random.Random(3)
    rv = RealizedVol(halflife_min=500)
    px, sig = 100.0, 0.5
    t = 0
    for _ in range(3000):
        px *= math.exp(sig * math.sqrt(1 / 525_600) * rng.gauss(0, 1))
        t += 60_000_000_000
        rv.on_spot("BTC", px, t)
    assert rv.sigma("BTC") == pytest.approx(0.5, rel=0.15)


def test_pool_and_interp():
    assert pool({"options": 0.6, "realized": None}) == pytest.approx(0.6)
    assert 0.5 < pool({"options": 0.7, "own": 0.6}) < 0.7
    assert pool({}) is None
    assert interp_curve([(100, 0.8), (110, 0.4)], 105) == pytest.approx(0.6)
    assert interp_curve([(100, 0.8), (110, 0.4)], 120) is None
