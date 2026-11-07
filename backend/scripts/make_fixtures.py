"""Generate the UI's mock-mode fixtures from the synthetic market, through the same view
functions the API serves. Output: frontend/src/mocks/*.json. Synthetic data only."""

from __future__ import annotations

import sys
from pathlib import Path

import orjson

from edgedesk.api import views as V
from edgedesk.api.main import DEFAULT_SETTINGS
from edgedesk.core.engine import Config, Engine
from edgedesk.core.replay import md_stream
from edgedesk.eval import analytics as A
from edgedesk.eval.sweeps import edge_decay
from edgedesk.sim.synthetic import Scenario, generate

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "mocks"
NS = 1_000_000_000


def dump(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_bytes(orjson.dumps(obj, option=orjson.OPT_INDENT_2 | orjson.OPT_NON_STR_KEYS))
    print(f"wrote {name}.json ({(OUT / f'{name}.json').stat().st_size // 1024} KB)")


def main() -> None:
    sc = Scenario(hours=6.0, seed=21)
    recs = generate(sc)
    stream = list(md_stream(recs))
    cfg = Config(trade_model="hybrid")
    cut = recs[0]["t_recv"] + int(4.6 * 3600 * NS)
    eng = Engine(cfg, measure=True)
    for t, k, d in stream:
        if t > cut:
            break
        eng.process(t, k, d)
    recorder = {"health": {"kalshi": {"ok": 4210, "err": 0, "last_rtt_ms": 124.6},
                           "polymarket": {"ok": 1730, "err": 1, "last_rtt_ms": 61.2},
                           "polymarket_ws": {"ok": 98211, "err": 0}, "deribit": {"ok": 2120, "err": 0, "last_rtt_ms": 41.8},
                           "deribit_ws": {"ok": 9820, "err": 0}, "coinbase": {"ok": 3300, "err": 0, "last_rtt_ms": 30.9},
                           "coinbase_ws": {"ok": 5020, "err": 0}, "binance": {"ok": 1650, "err": 0, "last_rtt_ms": 228.4},
                           "binance_ws": {"ok": 71200, "err": 0}}}
    desk = V.desk(eng, recorder, "mock")
    desk["desk"] = {"source": "mock", "caught_up": True, "records": len(recs), "uptime_s": 16540, "engine_t": eng.t // 10**6,
                    "lag_s": 2.1}
    dump("desk", desk)
    dump("positions", V.positions(eng))
    dump("risk", V.risk(eng, recorder))
    dump("capital", V.capital(eng))
    full = Engine(cfg)
    for t, k, d in stream:
        full.process(t, k, d)
    full.finish()
    models = V.models(full, {"enabled": False, "available": False, "active": False,
                             "message": "Set KUMO_API_KEY in .env to enable"})
    dump("models", models)
    decay = edge_decay(stream, cfg, [0, 250, 1000, 2000, 5000, 10000, 20000, 30000, 60000])
    lat = V.latency(eng, recs, decay=decay)
    lat["edge_decay_meta"] = {"data": "synthetic (mock)", "base_one_way_ms": cfg.latency_ms}
    dump("latency", lat)
    dump("settings", {**DEFAULT_SETTINGS, "kumo": models["kumo"], "source": "mock",
                      "models": ["options", "hybrid", "ensemble", "realized"], "order_styles": ["taker", "maker"]})
    hours = sorted({f"{r['t_recv'] // (3600 * NS)}" for r in recs})
    dump("periods", {"hours": [{"hour": f"2026-11-07T{12 + i:02d}:00Z", "bytes": 21_000_000, "compressed": i < len(hours) - 1}
                               for i in range(len(hours))], "results": {"edge_decay": True, "sweep": None}})
    tr = A.trades(full)
    dump("replay_job", {"id": "mock1234", "status": "done", "records": len(recs), "request": {"synthetic": True},
                        "result": {"summary": A.pnl_summary(full, tr), "equity_curve": A.equity_curve(full),
                                   "attribution": A.attribution(tr), "digest": full.log.digest, "events": full.log.seq,
                                   "seconds": 3.1, "trades": list(reversed(tr))[:100],
                                   "calibration": A.calibration(A.calibration_samples(full)).get("all"),
                                   "edge_decay": decay}})
    dump("health", {"ok": True, "paper_only": True, "source": "mock", "desk": desk["desk"], "recorder": None,
                    "data_hours": len(hours), "data_from": "2026-11-07 12:00 UTC"})


if __name__ == "__main__":
    sys.exit(main())
