from edgedesk.core.engine import Config
from edgedesk.core.replay import md_stream, run_events
from edgedesk.eval import analytics as A
from edgedesk.models import kumo


class FakeClient:
    def __init__(self):
        self.calls = []

    def predict(self, markets, snapshots, cids, anchor_ms):
        self.calls.append((markets, snapshots, cids, anchor_ms))
        # a "model" that just echoes the hybrid probability of the last snapshot
        last = {}
        for s in snapshots:
            last[s["cid"]] = s["p_hybrid"] if s["p_hybrid"] is not None else 0.5
        return {c: last.get(c, 0.5) for c in cids}


def test_status_without_key(monkeypatch):
    monkeypatch.delenv("KUMO_API_KEY", raising=False)
    st = kumo.status(True)
    assert st["available"] is False and st["active"] is False and "KUMO_API_KEY" in st["message"]


def test_status_with_key(monkeypatch):
    monkeypatch.setenv("KUMO_API_KEY", "dummy")
    assert kumo.status(False)["active"] is False
    assert kumo.status(True)["active"] is True


def test_tables_have_no_lookahead_and_predictions_feed_calibration(synth_long):
    eng = run_events(md_stream(synth_long), Config(trade=False))
    anchor = synth_long[0]["t_recv"] + int(1.2 * 3600 * 1e9)
    markets, snaps = kumo.build_tables(eng, anchor)
    assert all(s["t"] * 1_000_000 <= anchor for s in snaps)
    labelled = [m for m in markets if m["outcome"] is not None]
    assert labelled and all(m["expiry"] * 1_000_000 <= anchor for m in labelled)
    fake = FakeClient()
    res = kumo.predict_open(eng, client=fake, anchor_ns=anchor)
    assert res["returned"] == res["requested"] > 0
    assert "PREDICT markets.outcome" in kumo.query_for(["a"])
    rows = A.calibration_samples(eng)
    assert any(r.get("p_kumo") is not None for r in rows)
    cal = A.calibration(rows)["all"]["models"]
    assert "p_kumo" in cal


def test_client_errors_never_raise(synth_recs, monkeypatch):
    monkeypatch.delenv("KUMO_API_KEY", raising=False)
    eng = run_events(md_stream(synth_recs), Config(trade=False))
    res = kumo.predict_open(eng)
    assert "error" in res
