"""Fault injection: the engine recovers or halts safely, and never trades on bad state."""

import pytest

from edgedesk.core import events as E
from edgedesk.core.engine import Config
from edgedesk.core.replay import md_stream, run_events
from edgedesk.sim.faults import Faults, inject

NS = 1_000_000_000


def run(recs, **cfg):
    return run_events(md_stream(recs), Config(**cfg))


def assert_safe(e):
    assert all(ev.data["ok"] for ev in e.log.of(E.RECON)), "books must always reconcile"
    for o in e.orders.values():
        assert not o.open and o.filled <= o.qty
    # every order was preceded by an accepted risk decision
    ok_signals = {ev.data["signal"] for ev in e.log.of(E.RISK) if ev.data["ok"]}
    assert len(ok_signals) == sum(1 for ev in e.log.of(E.ORDER) if ev.data["event"] == "new")


@pytest.mark.parametrize("faults", [
    Faults(drop=0.2),
    Faults(gap_s=900),
    Faults(duplicate=0.2),
    Faults(reorder=0.05),
    Faults(malformed=0.05),
    Faults(errors_429=6),
    Faults(skew_ms=10_000, skew_p=0.05),
    Faults(delay_s=45, delay_p=0.02),
    Faults(drop=0.05, duplicate=0.05, reorder=0.02, malformed=0.02, errors_429=3, skew_ms=5000, skew_p=0.02),
], ids=["drop", "gap", "duplicate", "reorder", "malformed", "429s", "skew", "delay", "everything"])
def test_engine_survives_faults(synth_recs, faults):
    e = run(inject(synth_recs, faults))
    assert_safe(e)


def test_duplicates_are_dropped_exactly(synth_recs):
    clean = run(synth_recs)
    dup = run(inject(synth_recs, Faults(duplicate=0.3)))
    assert dup.log.counts[E.REJECT_INPUT] > 0
    assert dup.log.counts[E.FILL] == clean.log.counts[E.FILL]
    assert dup.pf.cash == pytest.approx(clean.pf.cash)


def test_malformed_input_never_reaches_state(synth_recs):
    e = run(inject(synth_recs, Faults(malformed=0.1, seed=3)))
    reasons = {ev.data["reason"] for ev in e.log.of(E.REJECT_INPUT)}
    assert reasons & {"bad book levels", "bad spot quote", "bad chain row", "bad index price", "empty chain"}
    for b in e.books.values():
        assert all(0 < p < 1 for p, _ in b.bids + b.asks)


def test_no_orders_on_a_degraded_feed(synth_recs):
    e = run(inject(synth_recs, Faults(skew_ms=10_000, skew_p=0.2, seed=4)))
    # reconstruct feed health over time from FEED events and check every new order
    state, timeline = {}, []
    for ev in e.log.events:
        if ev.kind == E.FEED:
            state[ev.data["feed"]] = ev.data["ok"]
        elif ev.kind == E.ORDER and ev.data["event"] == "new":
            venue = ev.data["venue"]
            spot = {"kalshi": "coinbase", "polymarket": "binance"}[venue]
            timeline.append(all(state.get(f, True) for f in (venue, spot, "deribit")))
    assert all(timeline)
    assert any(ev.kind == E.FEED and not ev.data["ok"] for ev in e.log.events)


def test_faulted_runs_are_reproducible(synth_recs):
    f = Faults(drop=0.1, duplicate=0.1, reorder=0.02, malformed=0.02, seed=9)
    assert run(inject(synth_recs, f)).log.digest == run(inject(synth_recs, f)).log.digest
