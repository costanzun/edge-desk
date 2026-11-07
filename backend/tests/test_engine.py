import os
import subprocess
import sys
from collections import Counter

from edgedesk.core import events as E
from edgedesk.core.engine import Config, Engine
from edgedesk.core.replay import md_stream, run_events

NS = 1_000_000_000


def run(recs, **cfg):
    return run_events(md_stream(recs), Config(**cfg))


def test_replay_is_bit_for_bit_deterministic(synth_recs):
    a, b = run(synth_recs), run(synth_recs)
    assert a.log.digest == b.log.digest
    assert a.log.seq == b.log.seq and a.log.counts == b.log.counts
    assert a.log.counts[E.FILL] > 0 and a.log.counts[E.SETTLE] > 0


def test_determinism_across_processes_and_hash_seeds():
    code = ("from edgedesk.sim.synthetic import generate, Scenario;"
            "from edgedesk.core.replay import md_stream, run_events;"
            "print(run_events(md_stream(generate(Scenario(hours=1.5)))).log.digest)")
    digests = set()
    for seed in ("1", "2"):
        env = {**os.environ, "PYTHONHASHSEED": seed}
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, check=True)
        digests.add(out.stdout.strip())
    assert len(digests) == 1


def test_config_changes_change_the_digest(synth_recs):
    assert run(synth_recs).log.digest != run(synth_recs, added_latency_ms=5000).log.digest


def test_every_order_passed_risk_and_states_are_legal(synth_recs):
    e = run(synth_recs)
    risk_ok = {ev.data["signal"] for ev in e.log.of(E.RISK) if ev.data["ok"]}
    assert len(risk_ok) == sum(1 for ev in e.log.of(E.ORDER) if ev.data["event"] == "new")
    assert not e.log.of(E.HALT) or all("state machine" not in h.data["reason"] for h in e.log.of(E.HALT))
    for o in e.orders.values():
        assert not o.open
        assert o.filled <= o.qty
    assert all(ev.data["ok"] for ev in e.log.of(E.RECON))


def test_fills_happen_after_latency_against_the_arrival_book(synth_recs):
    e = run(synth_recs, latency_ms={"kalshi": 250.0, "polymarket": 250.0})
    news = {ev.data["oid"]: ev.t for ev in e.log.of(E.ORDER) if ev.data["event"] == "new"}
    for ev in e.log.of(E.FILL):
        assert ev.t - news[ev.data["oid"]] >= 2 * 250 * 1_000_000  # there and back


def test_idempotency_key_never_creates_a_second_order(synth_recs):
    e = run(synth_recs[:5000])
    c = next(iter(e.contracts.values()))
    o1 = e.submit(e.t, c, "yes", 0.5, 10, "same-key")
    o2 = e.submit(e.t + 1, c, "yes", 0.5, 10, "same-key")
    assert o1 is o2 and sum(1 for o in e.orders.values() if o.key == "same-key") == 1
    assert e.log.events[-1].data["event"] == "duplicate_key_ignored"


def test_kill_switch_blocks_new_orders(synth_recs):
    t_kill = synth_recs[len(synth_recs) // 4]["t_recv"]
    ctrl = {"seq": -1, "src": "control", "kind": "kill", "t_recv": t_kill, "data": {"action": "kill", "reason": "test"}}
    recs = sorted(synth_recs + [ctrl], key=lambda r: (r["t_recv"], r["seq"]))
    e = run(recs)
    assert e.halted and e.halt_reason == "test"
    late_orders = [ev for ev in e.log.of(E.ORDER) if ev.data["event"] == "new" and ev.t > t_kill]
    assert late_orders == []
    assert any("not_halted" in ev.data["failed"] for ev in e.log.of(E.RISK) if ev.t > t_kill)
    # resume re-enables trading
    resume = {"seq": -2, "src": "control", "kind": "resume", "t_recv": t_kill + 60 * NS, "data": {"action": "resume"}}
    e2 = run(sorted(recs + [resume], key=lambda r: (r["t_recv"], r["seq"])))
    assert not e2.halted


def test_kill_switch_cancels_resting_maker_orders(synth_recs):
    t_kill = synth_recs[len(synth_recs) // 3]["t_recv"]
    ctrl = {"seq": -1, "src": "control", "kind": "kill", "t_recv": t_kill, "data": {"action": "kill"}}
    e = run(sorted(synth_recs + [ctrl], key=lambda r: (r["t_recv"], r["seq"])), order_style="maker",
            maker_ttl_s=3600)
    states = Counter(o.state for o in e.orders.values())
    assert states["cancelled"] > 0
    assert all(not o.open for o in e.orders.values())


def test_reconciliation_break_halts_trading(synth_recs):
    eng = Engine(Config())
    stream = list(md_stream(synth_recs))
    half = len(stream) // 2
    for t, k, d in stream[:half]:
        eng.process(t, k, d)
    eng.pf.cash += 5.0  # corrupt one side of the books
    eng.reconcile(eng.t)
    assert eng.halted and "reconciliation" in eng.halt_reason
    n_orders = len(eng.orders)
    for t, k, d in stream[half:]:
        eng.process(t, k, d)
    assert len(eng.orders) == n_orders


def test_daily_loss_limit_halts():
    from edgedesk.risk.limits import RiskLimits
    from edgedesk.sim.synthetic import Scenario, generate
    recs = generate(Scenario(hours=2.0, seed=5))
    e = run(recs, limits=RiskLimits(daily_loss_limit=1.0))
    assert e.halted and "daily loss" in e.halt_reason


def test_latency_costs_money_on_lagged_quotes(synth_long):
    fast = run(synth_long, added_latency_ms=0)
    slow = run(synth_long, added_latency_ms=30_000)
    assert fast.log.counts[E.FILL] > slow.log.counts[E.FILL]


def test_stale_spot_blocks_trading(synth_recs):
    recs = [r for r in synth_recs if r["src"] not in ("coinbase", "binance") or r["t_recv"] < synth_recs[0]["t_recv"] + 600 * NS]
    e = run(recs)
    t_cut = synth_recs[0]["t_recv"] + 620 * NS
    assert not [ev for ev in e.log.of(E.ORDER) if ev.data["event"] == "new" and ev.t > t_cut]
