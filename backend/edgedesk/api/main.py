"""Edge Desk API (FastAPI, :8104). Paper trading only: nothing here can reach a venue's
order endpoint; the only outbound traffic is the recorder's public market data."""

from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import orjson
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel, Field

from edgedesk.api import views as V
from edgedesk.api.desk import Desk
from edgedesk.capital import tools as C
from edgedesk.core.engine import Config
from edgedesk.core.reader import hour_files, records
from edgedesk.core.replay import md_stream, run_events
from edgedesk.eval import analytics as A
from edgedesk.models import kumo
from edgedesk.risk.limits import RiskLimits

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")
DATA = Path(os.environ.get("EDGE_DATA_DIR", ROOT / "data"))
SOURCE = os.environ.get("EDGE_SOURCE", "live")          # live | synthetic | replay
SPEED = float(os.environ.get("EDGE_SPEED", "30"))
SETTINGS_PATH = DATA / ("settings.json" if SOURCE == "live" else f"settings-{SOURCE}.json")
RESULTS = ROOT / "eval" / "results"

DEFAULT_SETTINGS: dict[str, Any] = {
    "trade_model": "hybrid", "min_edge": 0.02, "band_k": 1.0, "kelly_fraction": 0.25, "bankroll": 10_000.0,
    "order_style": "taker", "added_latency_ms": 0.0, "depth_haircut": 0.5, "lookback_h": 24.0,
    "kumo_enabled": False, "limits": RiskLimits().as_dict(),
}


def load_settings() -> dict[str, Any]:
    s = dict(DEFAULT_SETTINGS)
    try:
        s.update(orjson.loads(SETTINGS_PATH.read_bytes()))
    except (OSError, orjson.JSONDecodeError):
        pass
    s["limits"] = {**RiskLimits().as_dict(), **(s.get("limits") or {})}
    return s


def config_from(s: dict[str, Any]) -> Config:
    base = Config()
    lat = base.latency_ms
    measured = _read_result("latency.json")
    if measured and measured.get("one_way_ms"):
        lat = {**lat, **measured["one_way_ms"]}
    return replace(base, trade_model=s["trade_model"], min_edge=float(s["min_edge"]), band_k=float(s["band_k"]),
                   kelly_fraction=float(s["kelly_fraction"]), bankroll=float(s["bankroll"]),
                   order_style=s["order_style"], added_latency_ms=float(s["added_latency_ms"]),
                   depth_haircut=float(s["depth_haircut"]), latency_ms=lat, limits=RiskLimits(**s["limits"]))


def _read_result(name: str) -> Any:
    try:
        return orjson.loads((RESULTS / name).read_bytes())
    except (OSError, orjson.JSONDecodeError):
        return None


def _recorder_status() -> dict | None:
    try:
        st = orjson.loads((ROOT / "logs" / "recorder_status.json").read_bytes())
        st["age_s"] = round(time.time() - st.get("t", 0), 1)
        return st
    except (OSError, orjson.JSONDecodeError):
        return None


app = FastAPI(title="Edge Desk API", version="0.1.0", default_response_class=ORJSONResponse)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
                   allow_methods=["*"], allow_headers=["*"])

STATE: dict[str, Any] = {"settings": load_settings(), "desk": None, "jobs": {}}
_desk_lock = threading.Lock()


def start_desk() -> Desk:
    with _desk_lock:
        old = STATE["desk"]
        if old:
            old.stop()
        s = STATE["settings"]
        d = Desk(DATA, config_from(s), source=SOURCE, lookback_h=float(s["lookback_h"]), speed=SPEED)
        d.start()
        STATE["desk"] = d
        return d


@app.on_event("startup")
def _startup() -> None:
    start_desk()


def desk() -> Desk:
    return STATE["desk"] or start_desk()


# ---------------------------------------------------------------------- read views
@app.get("/api/health")
def health() -> dict[str, Any]:
    d = desk()
    files = hour_files(DATA / "raw")
    return {"ok": True, "paper_only": True, "source": SOURCE, "desk": d.status(), "recorder": _recorder_status(),
            "data_hours": len(files), "data_from": files[0].parent.name + " " + files[0].name[:2] + ":00 UTC" if files else None}


@app.get("/api/desk")
def get_desk() -> dict[str, Any]:
    d = desk()
    with d.lock:
        out = V.desk(d.engine, _recorder_status(), SOURCE)
    out["desk"] = d.status()
    return out


@app.get("/api/positions")
def get_positions() -> dict[str, Any]:
    d = desk()
    with d.lock:
        return V.positions(d.engine)


@app.get("/api/risk")
def get_risk() -> dict[str, Any]:
    d = desk()
    with d.lock:
        return V.risk(d.engine, _recorder_status())


@app.get("/api/capital")
def get_capital() -> dict[str, Any]:
    d = desk()
    with d.lock:
        return V.capital(d.engine)


@app.get("/api/models")
def get_models() -> dict[str, Any]:
    d = desk()
    with d.lock:
        out = V.models(d.engine, kumo.status(STATE["settings"].get("kumo_enabled", False)))
    out["evaluation"] = _read_result("calibration.json")
    return out


@app.get("/api/latency")
def get_latency() -> dict[str, Any]:
    d = desk()
    with d.lock:
        recs = list(d.net_recs)
        out = V.latency(d.engine, recs, decay=(_read_result("edge_decay.json") or {}).get("rows"))
    out["edge_decay_meta"] = {k: v for k, v in (_read_result("edge_decay.json") or {}).items() if k != "rows"}
    return out


@app.get("/api/report")
def get_report() -> dict[str, Any]:
    rep = _read_result("report.json")
    if rep is None:
        raise HTTPException(404, "no evaluation report yet: run `uv run python -m edgedesk.eval.report`")
    return rep


@app.get("/api/events")
def get_events(kinds: str = "signal,order,fill,settle,risk,halt,feed,recon", limit: int = 200) -> list[dict]:
    d = desk()
    ks = tuple(k.strip() for k in kinds.split(","))
    with d.lock:
        return V._event_rows(d.engine, ks, min(limit, 2000))


@app.post("/api/models/kumo/run")
def run_kumo() -> dict[str, Any]:
    """Ask KumoRFM for the open contracts (only with the setting on and a key in .env)."""
    st = kumo.status(STATE["settings"].get("kumo_enabled", False))
    if not st["active"]:
        raise HTTPException(409, st["message"])
    d = desk()
    with d.lock:
        res = kumo.predict_open(d.engine)
    return {k: v for k, v in res.items() if k != "predictions"}


# ---------------------------------------------------------------------- control
class ControlBody(BaseModel):
    reason: str = ""


@app.post("/api/risk/kill")
def kill(body: ControlBody) -> dict[str, Any]:
    return desk().control("kill", body.reason)


@app.post("/api/risk/resume")
def resume(body: ControlBody) -> dict[str, Any]:
    return desk().control("resume", body.reason)


class KellyBody(BaseModel):
    p: float = Field(ge=0, le=1)
    price: float = Field(gt=0, lt=1)
    venue: str = "kalshi"
    band: float = Field(0.0, ge=0, le=0.5)
    fraction: float = Field(0.25, gt=0, le=1)
    bankroll: float = Field(10_000.0, gt=0)


@app.post("/api/capital/kelly")
def kelly(body: KellyBody) -> dict[str, Any]:
    from edgedesk.sim.fees import fee_per_contract
    return C.kelly(body.p, body.price, fee_per_contract(body.venue, body.price), body.band, body.fraction, body.bankroll)


# ---------------------------------------------------------------------- settings
class SettingsBody(BaseModel):
    trade_model: str | None = None
    min_edge: float | None = Field(None, ge=0, le=0.5)
    band_k: float | None = Field(None, ge=0, le=5)
    kelly_fraction: float | None = Field(None, gt=0, le=1)
    bankroll: float | None = Field(None, gt=0)
    order_style: str | None = None
    added_latency_ms: float | None = Field(None, ge=0, le=600_000)
    depth_haircut: float | None = Field(None, gt=0, le=1)
    lookback_h: float | None = Field(None, gt=0, le=24 * 14)
    kumo_enabled: bool | None = None
    limits: dict[str, float] | None = None


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return {**STATE["settings"], "kumo": kumo.status(STATE["settings"].get("kumo_enabled", False)),
            "source": SOURCE, "models": ["options", "hybrid", "ensemble", "realized"],
            "order_styles": ["taker", "maker"]}


@app.put("/api/settings")
def put_settings(body: SettingsBody) -> dict[str, Any]:
    s = dict(STATE["settings"])
    upd = body.model_dump(exclude_none=True)
    if "trade_model" in upd and upd["trade_model"] not in ("options", "hybrid", "ensemble", "realized"):
        raise HTTPException(422, "unknown model")
    if "order_style" in upd and upd["order_style"] not in ("taker", "maker"):
        raise HTTPException(422, "unknown order style")
    if "limits" in upd:
        s["limits"] = {**s["limits"], **{k: v for k, v in upd.pop("limits").items() if k in s["limits"]}}
    s.update(upd)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_bytes(orjson.dumps(s, option=orjson.OPT_INDENT_2))
    STATE["settings"] = s
    start_desk()  # re-fold the log with the new configuration
    return get_settings()


# ---------------------------------------------------------------------- replay
@app.get("/api/replay/periods")
def periods() -> dict[str, Any]:
    out = []
    for f in hour_files(DATA / "raw"):
        out.append({"hour": f"{f.parent.name}T{f.name[:2]}:00Z", "bytes": f.stat().st_size,
                    "compressed": f.suffix == ".gz"})
    return {"hours": out, "results": {"edge_decay": _read_result("edge_decay.json") is not None,
                                      "sweep": _read_result("sweep.json")}}


class ReplayBody(BaseModel):
    start_ms: int | None = None
    end_ms: int | None = None
    synthetic: bool = False
    settings: dict[str, Any] = {}
    latencies_ms: list[float] = []


def _run_job(job_id: str, body: ReplayBody) -> None:
    job = STATE["jobs"][job_id]
    try:
        s = {**STATE["settings"], **body.settings}
        cfg = config_from(s)
        if body.synthetic:
            from edgedesk.sim.synthetic import Scenario, generate
            recs = generate(Scenario(hours=4.0, seed=21))
        else:
            recs = list(records(DATA, body.start_ms * 1_000_000 if body.start_ms else None,
                                body.end_ms * 1_000_000 if body.end_ms else None))
        job["records"] = len(recs)
        stream = list(md_stream(recs))
        t0 = time.time()
        eng = run_events(stream, cfg)
        tr = A.trades(eng)
        job["result"] = {"summary": A.pnl_summary(eng, tr), "equity_curve": A.equity_curve(eng),
                         "attribution": A.attribution(tr), "digest": eng.log.digest, "events": eng.log.seq,
                         "seconds": round(time.time() - t0, 2), "trades": list(reversed(tr))[:100],
                         "calibration": A.calibration(A.calibration_samples(eng)).get("all")}
        if body.latencies_ms:
            from edgedesk.eval.sweeps import edge_decay
            job["status"] = "edge decay"
            job["result"]["edge_decay"] = edge_decay(stream, cfg, body.latencies_ms[:12])
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"


@app.post("/api/replay")
def start_replay(body: ReplayBody) -> dict[str, Any]:
    running = [j for j in STATE["jobs"].values() if j["status"] not in ("done", "error")]
    if running:
        raise HTTPException(409, "a replay is already running")
    job_id = uuid.uuid4().hex[:8]
    STATE["jobs"][job_id] = {"id": job_id, "status": "running", "created": time.time(), "request": body.model_dump()}
    threading.Thread(target=_run_job, args=(job_id, body), daemon=True).start()
    return STATE["jobs"][job_id]


@app.get("/api/replay/{job_id}")
def get_replay(job_id: str) -> dict[str, Any]:
    job = STATE["jobs"].get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job
