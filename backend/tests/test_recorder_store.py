
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
