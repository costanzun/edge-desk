"""API smoke tests against the synthetic market (no network, own temp data dir)."""

import importlib
import time

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    import os
    d = tmp_path_factory.mktemp("data")
    os.environ["EDGE_DATA_DIR"] = str(d)
    os.environ["EDGE_SOURCE"] = "synthetic"
    os.environ["EDGE_SPEED"] = "2000"
    from edgedesk.api import main
    main = importlib.reload(main)
    with TestClient(main.app) as c:
        for _ in range(100):
            if c.get("/api/health").json()["desk"]["records"] > 20000:
                break
            time.sleep(0.2)
        yield c
    main.STATE["desk"].stop()
    for k in ("EDGE_DATA_DIR", "EDGE_SOURCE", "EDGE_SPEED"):
        os.environ.pop(k, None)


def test_health_is_paper_only(client):
    h = client.get("/api/health").json()
    assert h["ok"] and h["paper_only"] and h["source"] == "synthetic"


@pytest.mark.parametrize("path", ["desk", "positions", "risk", "capital", "models", "latency", "settings",
                                  "replay/periods", "events"])
def test_views_respond(client, path):
    r = client.get(f"/api/{path}")
    assert r.status_code == 200, r.text


def test_desk_shape(client):
    d = client.get("/api/desk").json()
    for k in ("summary", "feeds", "opportunities", "curves", "signals", "orders", "digest"):
        assert k in d


def test_kill_and_resume(client):
    r = client.post("/api/risk/kill", json={"reason": "pytest"}).json()
    assert r["halted"] is True and r["action"] == "kill"
    assert client.get("/api/risk").json()["halted"] is True
    r = client.post("/api/risk/resume", json={}).json()
    assert r["halted"] is False


def test_kelly_endpoint(client):
    k = client.post("/api/capital/kelly", json={"p": 0.62, "price": 0.55, "band": 0.02}).json()
    assert k["contracts"] > 0 and 0 < k["fraction_used"] < k["kelly_full"]
    assert client.post("/api/capital/kelly", json={"p": 2, "price": 0.5}).status_code == 422


def test_settings_validation_and_refold(client):
    assert client.put("/api/settings", json={"trade_model": "nope"}).status_code == 422
    s = client.put("/api/settings", json={"min_edge": 0.03}).json()
    assert s["min_edge"] == 0.03


def test_kumo_run_refused_without_key(client, monkeypatch):
    monkeypatch.delenv("KUMO_API_KEY", raising=False)
    assert client.post("/api/models/kumo/run").status_code == 409


def test_replay_job_is_deterministic(client):
    digests = []
    for _ in range(2):
        job = client.post("/api/replay", json={"synthetic": True}).json()
        for _ in range(300):
            j = client.get(f"/api/replay/{job['id']}").json()
            if j["status"] in ("done", "error"):
                break
            time.sleep(0.2)
        assert j["status"] == "done", j.get("error")
        digests.append(j["result"]["digest"])
    assert digests[0] == digests[1]
