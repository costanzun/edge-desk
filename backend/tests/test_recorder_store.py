
import orjson

from edgedesk.core.reader import records
from edgedesk.recorder.store import RawLog, compress, last_seq

H = 3600 * 1_000_000_000


def test_sequence_survives_restart_and_rotation(tmp_path):
    raw = tmp_path / "raw"
    log = RawLog(raw)
    t0 = 1_794_049_200 * 1_000_000_000
    for i in range(5):
        log.append("kalshi", "x", {"i": i}, t_recv=t0 + i)
    log.append("kalshi", "x", {"i": 5}, t_recv=t0 + H)  # next hour: rotates
    log.close()
    log2 = RawLog(raw)
    assert log2.seq == 6
    log2.append("kalshi", "x", {"i": 6}, t_recv=t0 + H + 1)
    log2.close()
    files = sorted(raw.glob("*/*.jsonl*"))
    for f in files:
        if f.suffix == ".jsonl" and f.name.startswith("12"):
            compress(f)
    seqs = [r["seq"] for r in records(tmp_path)]
    assert seqs == list(range(1, 8))
    assert last_seq(raw) == 7


def test_torn_last_line_is_ignored(tmp_path):
    raw = tmp_path / "raw" / "2026-11-07"
    raw.mkdir(parents=True)
    t = 1_794_049_200 * 1_000_000_000
    good = orjson.dumps({"seq": 1, "src": "a", "kind": "b", "t_recv": t, "data": {}})
    (raw / "12.jsonl").write_bytes(good + b"\n" + b'{"seq": 2, "src": "a", "ki')
    assert [r["seq"] for r in records(tmp_path)] == [1]
    assert last_seq(tmp_path / "raw") == 1


def test_late_record_at_hour_boundary_never_rotates_backwards(tmp_path):
    """Regression: a record received just before the hour but written just after it must not
    rotate back (which used to compress and unlink the file being written)."""
    raw = tmp_path / "raw"
    log = RawLog(raw)
    t_hour = 1_794_052_800 * 1_000_000_000  # 15:00:00 UTC
    log.append("a", "x", {}, t_recv=t_hour - 5_000_000)
    log.append("a", "x", {}, t_recv=t_hour + 1_000)        # rotates to 15:00
    log.append("a", "x", {}, t_recv=t_hour - 1_000)        # late: stays in the 15:00 file
    log.append("a", "x", {}, t_recv=t_hour + 2_000)
    log.close()
    import time as _t
    _t.sleep(0.3)  # let the background compression of the 14:00 file finish
    assert (raw / "2026-11-07" / "15.jsonl").exists()
    assert [r["seq"] for r in records(tmp_path)] == [1, 3, 2, 4]  # ordered by receive time
