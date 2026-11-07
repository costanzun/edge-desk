"""Edge-decay curve and parameter sweeps over replayed data, with an out-of-sample split."""

from __future__ import annotations

import itertools
from dataclasses import replace
from typing import Any

from edgedesk.core.engine import Config
from edgedesk.core.replay import run_events
from edgedesk.eval.analytics import pnl_summary, trades

DEFAULT_LATENCIES_MS = [0, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000]


def edge_decay(stream: list, cfg: Config, latencies_ms: list[float] | None = None) -> list[dict[str, Any]]:
    out = []
    for lat in latencies_ms or DEFAULT_LATENCIES_MS:
        eng = run_events(stream, replace(cfg, added_latency_ms=float(lat)))
        tr = trades(eng)
        s = pnl_summary(eng, tr)
        exp_edge = sum((x["attr"] or {}).get("edge", 0.0) for x in tr)
        lat_cost = sum((x["attr"] or {}).get("latency", 0.0) for x in tr)
        out.append({"added_ms": lat, "net": s["net_total"], "net_settled": s["net_settled"], "fees": s["fees"],
                    "trades": s["trades"], "contracts": s["contracts"], "signals": s["signals"],
                    "expected_edge": round(exp_edge, 2), "latency_cost": round(lat_cost, 2),
                    "digest": eng.log.digest[:12]})
    return out


def split_stream(stream: list, frac: float = 0.5) -> tuple[list, list, int]:
    t0, t1 = stream[0][0], stream[-1][0]
    cut = t0 + int((t1 - t0) * frac)
    first = [e for e in stream if e[0] < cut]
    # the test half still needs the contract definitions announced during the first half
    defs = [e for e in first if e[1] == "md.contract"]
    second = [(cut, k, d) for _, k, d in defs] + [e for e in stream if e[0] >= cut]
    return first, second, cut


GRID = {"trade_model": ["options", "hybrid", "ensemble"], "min_edge": [0.01, 0.02, 0.04, 0.06],
        "band_k": [0.0, 1.0, 2.0]}


def sweep(stream: list, base: Config, grid: dict[str, list] | None = None, frac: float = 0.5) -> dict[str, Any]:
    """Pick parameters on the first part of the data, report them on the rest."""
    grid = grid or GRID
    train, test, cut = split_stream(stream, frac)
    keys = list(grid)
    rows = []
    for vals in itertools.product(*(grid[k] for k in keys)):
        cfg = replace(base, **dict(zip(keys, vals)))
        s_tr = pnl_summary(run_events(train, cfg))
        s_te = pnl_summary(run_events(test, cfg))
        rows.append({**dict(zip(keys, vals)), "train_net": s_tr["net_total"], "train_trades": s_tr["trades"],
                     "test_net": s_te["net_total"], "test_trades": s_te["trades"]})
    best = max(rows, key=lambda r: (r["train_net"], -r["train_trades"]))
    default = next((r for r in rows if all(r[k] == getattr(base, k) for k in keys)), None)
    return {"cut_ms": cut // 1_000_000, "rows": rows, "best_in_sample": best, "default": default,
            "note": "Parameters are chosen on the first half (by time) and judged on the second half."}
