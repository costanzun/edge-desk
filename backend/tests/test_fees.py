import pytest

from edgedesk.sim import fees as F


def test_kalshi_taker_fee_published_examples():
    # 0.07 * 100 * 0.5 * 0.5 = 1.75 exactly (float noise must not round it up to 1.76)
    assert F.kalshi_fee(100, 0.50) == 1.75
    # one contract at 50c: 0.0175 -> rounded up to 2c
    assert F.kalshi_fee(1, 0.50) == 0.02
    assert F.kalshi_fee(10, 0.90) == pytest.approx(0.07)  # 0.063 -> 0.07


def test_kalshi_makers_free_on_quadratic_series():
    assert F.kalshi_fee(100, 0.5, maker=True) == 0.0
    assert F.kalshi_fee(100, 0.5, maker=True, maker_fees=True) == pytest.approx(0.44)  # 0.4375 -> 0.44


def test_kalshi_order_fee_rounds_once_per_order():
    fills = [(1, 0.5), (1, 0.5), (1, 0.5)]  # 3 x 0.0175 = 0.0525 -> 0.06, not 3 x 0.02
    assert F.kalshi_order_fee(fills) == 0.06


def test_polymarket_fee_formula_and_rounding():
    assert F.polymarket_fee(100, 0.5) == pytest.approx(1.75)  # docs example
    assert F.polymarket_fee(100, 0.5, maker=True) == 0.0
    assert F.polymarket_fee(0.0001, 0.5) == 0.0  # below the 0.00001 USDC minimum
    assert F.polymarket_fee(3, 0.123) == round(3 * 0.07 * 0.123 * 0.877, 5)


def test_fee_is_symmetric_and_peaks_at_half():
    assert F.fee_per_contract("kalshi", 0.2) == pytest.approx(F.fee_per_contract("kalshi", 0.8))
    assert F.fee_per_contract("kalshi", 0.5) > F.fee_per_contract("kalshi", 0.3)
