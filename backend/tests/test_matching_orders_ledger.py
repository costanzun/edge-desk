import pytest

from edgedesk.sim import matching as M
from edgedesk.sim.ledger import Ledger, Portfolio, Unbalanced, reconcile
from edgedesk.sim.orders import ACKED, CANCELLED, EXPIRED, FILLED, NEW, PARTIAL, IllegalTransition, Order

BIDS = [[0.40, 100.0], [0.39, 50.0]]
ASKS = [[0.42, 100.0], [0.43, 200.0], [0.50, 1000.0]]


def test_take_walks_levels_up_to_limit_with_haircut():
    consumed = {}
    fills = M.take("yes", 0.43, 500, BIDS, ASKS, consumed, haircut=0.5)
    assert fills == [(0.42, 50), (0.43, 100)]
    # liquidity we took stays consumed until the next book
    assert M.take("yes", 0.43, 500, BIDS, ASKS, consumed, haircut=0.5) == []


def test_take_no_side_hits_yes_bids():
    fills = M.take("no", 0.61, 1000, BIDS, ASKS, {}, haircut=1.0)
    assert fills == [(0.6, 100), (0.61, 50)]


def test_take_respects_limit():
    assert M.take("yes", 0.41, 10, BIDS, ASKS, {}) == []


def test_trade_through_only_strictly_better():
    assert M.trade_through("yes", 0.42, 100, BIDS, ASKS, 1.0) == 0  # at our price: no fill (queue)
    assert M.trade_through("yes", 0.43, 100, BIDS, ASKS, 1.0) == 100


def test_order_state_machine():
    o = Order(1, "k", "kalshi", "c", "yes", 0.5, 10, "ioc", 0)
    o.transition(ACKED, 1)
    o.transition(PARTIAL, 2)
    o.transition(FILLED, 3)
    assert not o.open
    with pytest.raises(IllegalTransition):
        o.transition(CANCELLED, 4)
    o2 = Order(2, "k2", "kalshi", "c", "yes", 0.5, 10, "ioc", 0)
    with pytest.raises(IllegalTransition):
        o2.transition(FILLED, 1)  # cannot fill before the venue acked
    o2.transition(ACKED, 1)
    o2.transition(EXPIRED, 2)
    assert o2.state == EXPIRED and o2.history[0] == (1, ACKED)
    assert Order(3, "k3", "kalshi", "c", "yes", 0.5, 1, "ioc", 0).state == NEW


def test_ledger_balances_and_settlement():
    lg, pf = Ledger(1000.0), Portfolio(1000.0)
    for book in (lg, pf):
        book.fill(*((0, "c1", "yes", 10, 0.4, 0.17) if book is lg else ("c1", "yes", 10, 0.4, 0.17)))
    assert lg.cash == pytest.approx(1000 - 4.17)
    assert reconcile(lg, pf) == []
    assert lg.settle(1, "c1", "yes", 1.0) == pytest.approx(6.0)
    assert pf.settle("c1", "yes", 1.0) == pytest.approx(6.0)
    assert lg.cash == pytest.approx(1000 - 4.17 + 10)
    assert reconcile(lg, pf) == []
    assert sum(lg.balances.values()) == pytest.approx(0.0)


def test_ledger_rejects_unbalanced_and_recon_detects_breaks():
    lg, pf = Ledger(100.0), Portfolio(100.0)
    with pytest.raises(Unbalanced):
        lg.post(0, "bad", [("cash", 1.0)])
    pf.fill("c", "no", 5, 0.3, 0.0)  # fold saw a fill the ledger never booked
    breaks = reconcile(lg, pf)
    assert any("units" in b for b in breaks) and any("cash" in b for b in breaks)
