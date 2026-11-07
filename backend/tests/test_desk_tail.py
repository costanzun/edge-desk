"""The live desk tails the raw log while the recorder writes and rotates it, and ends up in
exactly the state a replay of the same files gives."""

import time

from edgedesk.api.desk import Desk
from edgedesk.core.engine import Config
from edgedesk.core.reader import records
from edgedesk.core.replay import md_stream, run_events
from edgedesk.recorder.store import RawLog
from edgedesk.sim.synthetic import Scenario, generate


def test_live_tail_matches_replay(tmp_path, monkeypatch):
    recs = generate(Scenario(hours=1.2, seed=3))
    # shift the synthetic hour to "now" so the desk's lookback window includes it
    shift = time.time_ns() - recs[-1]["t_recv"] - 5_000_000_000
    for r in recs:
        r["t_recv"] += shift
    log = RawLog(tmp_path / "raw")
    half = len(recs) // 2
    for r in recs[:half]:
        log.append(r["src"], r["kind"], r["data"], t_recv=r["t_recv"], t_exch=r["t_exch"], rtt_ms=r["rtt_ms"])
    desk = Desk(tmp_path, Config(), source="live", lookback_h=3)
    desk.start()
    for r in recs[half:]:   # keeps writing (and rotating) while the desk tails
        log.append(r["src"], r["kind"], r["data"], t_recv=r["t_recv"], t_exch=r["t_exch"], rtt_ms=r["rtt_ms"])
    log.close()
    time.sleep(0.5)
    for _ in range(100):
        if desk.records >= len(recs):
            break
        time.sleep(0.2)
    desk.stop()
    assert desk.records == len(recs)
    replay = run_events(md_stream(records(tmp_path)), Config())
    # the live engine has not drained in-flight orders; compare inputs and decisions
    assert desk.engine.log.counts["md.book"] == replay.log.counts["md.book"]
    assert desk.engine.signals == replay.signals
