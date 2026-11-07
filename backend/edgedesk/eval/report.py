"""Evaluation report over the recorded data.

    uv run python -m edgedesk.eval.report [--sweep] [--decay]

Writes eval/results/*.json (served by the API), eval/report.md and eval/figures/*.png.
Protocol, fixed before looking at results:
- The headline run uses the default configuration (hybrid model, 2c min edge after fees and
  one error band, quarter Kelly, measured one-way latency). No parameter is tuned on it.
- The sweep picks parameters on the first half of the period (by time) and reports them on
  the second half, next to the default, so tuning gains are visible as such.
- Calibration is scored on model snapshots (one per contract per minute) of contracts that
  have resolved; snapshots of the same contract are correlated, so contract and event
  counts are reported next to every score.
"""

from __future__ import annotations

import argparse
import time
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson

from edgedesk.capital import tools as C
from edgedesk.core import events as E
from edgedesk.core.engine import Config
from edgedesk.core.reader import records
from edgedesk.core.replay import md_stream, run_events
from edgedesk.eval import analytics as A
from edgedesk.eval.sweeps import DEFAULT_LATENCIES_MS, edge_decay, sweep

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data"
RESULTS = ROOT / "eval" / "results"
FIG = ROOT / "eval" / "figures"


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).strftime("%Y-%m-%d %H:%M UTC")


def _dump(name: str, obj: Any) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / name).write_bytes(orjson.dumps(obj, option=orjson.OPT_INDENT_2 | orjson.OPT_NON_STR_KEYS))


def default_config(one_way: dict[str, float]) -> Config:
    base = Config(trade_model="hybrid")
    return replace(base, latency_ms={**base.latency_ms, **one_way})


def build(do_sweep: bool, do_decay: bool) -> dict[str, Any]:
    t_start = time.time()
    recs = list(records(DATA))
    if not recs:
        raise SystemExit("no recorded data in data/raw")
    net = A.network_latency(recs)
    one_way = A.one_way_from_rtt(net)
    cfg = default_config(one_way)
    stream = list(md_stream(recs))
    n_recs = len(recs)
    span = (recs[0]["t_recv"] // 1_000_000, recs[-1]["t_recv"] // 1_000_000)
    gaps = []
    prev = None
    for r in recs:
        if prev and r["t_recv"] - prev > 60 * 1_000_000_000:
            gaps.append({"from": _iso(prev // 1_000_000), "to": _iso(r["t_recv"] // 1_000_000),
                         "minutes": round((r["t_recv"] - prev) / 6e10, 1)})
        prev = r["t_recv"]
    del recs

    eng = run_events(stream, cfg, measure=True)
    eng2 = run_events(stream, cfg)
    deterministic = eng.log.digest == eng2.log.digest
    tr = A.trades(eng)
    summary = A.pnl_summary(eng, tr)
    curve = A.equity_curve(eng)
    attr = A.attribution(tr)
    rows = A.calibration_samples(eng)
    cal = {"all": A.calibration(rows).get("all"), "by_venue": A.calibration(rows, "venue"),
           "by_sym": A.calibration(rows, "sym")}
    rets = [x["pnl"] / cfg.bankroll for x in tr if x["pnl"] is not None]
    resolved = {"kalshi": sum(1 for c in eng.outcomes if eng.contracts[c]["venue"] == "kalshi"),
                "polymarket": sum(1 for c in eng.outcomes if eng.contracts[c]["venue"] == "polymarket")}
    venues = {}
    for v in ("kalshi", "polymarket"):
        tv = [x for x in tr if x["venue"] == v]
        venues[v] = A.pnl_summary(eng, tv) | {"trades": len(tv)}
    # the same strategy per traded model, default thresholds (not tuned)
    per_model = {}
    for m in ("options", "hybrid", "ensemble"):
        e_m = eng if m == cfg.trade_model else run_events(stream, replace(cfg, trade_model=m))
        per_model[m] = A.pnl_summary(e_m, A.trades(e_m))
    maker = run_events(stream, replace(cfg, order_style="maker"))
    per_model["hybrid (maker orders)"] = A.pnl_summary(maker, A.trades(maker))

    report: dict[str, Any] = {
        "generated": _iso(int(time.time() * 1000)), "period": {"from": _iso(span[0]), "to": _iso(span[1]),
                                                               "hours": round((span[1] - span[0]) / 3.6e6, 2)},
        "gaps": gaps, "records": n_recs, "md_events": len(stream), "engine_events": eng.log.seq,
        "contracts": len(eng.contracts), "resolved": resolved, "config": cfg.as_dict(),
        "deterministic": deterministic, "digest": eng.log.digest, "summary": summary, "by_venue": venues,
        "per_model": per_model, "attribution": attr, "equity_curve": curve, "max_drawdown": A.max_drawdown(curve),
        "stats": C.stats(rets), "risk_of_ruin": C.risk_of_ruin(rets) if rets else None,
        "risk": {"decisions": eng.log.counts[E.RISK], "halts": [ev.data for ev in eng.log.of(E.HALT)],
                 "recon_checks": eng.log.counts[E.RECON],
                 "recon_ok": all(ev.data["ok"] for ev in eng.log.of(E.RECON)),
                 "input_rejects": eng.log.counts[E.REJECT_INPUT]},
        "latency": {"one_way_ms": one_way, "network": net, "hops": A.hop_latency(eng)},
        "calibration": cal,
    }
    _dump("latency.json", report["latency"])
    _dump("calibration.json", cal)
    if do_decay:
        decay = edge_decay(stream, cfg, DEFAULT_LATENCIES_MS)
        _dump("edge_decay.json", {"rows": decay, "base_one_way_ms": cfg.latency_ms, "data": "recorded",
                                  "period": report["period"]})
        report["edge_decay"] = decay
    elif (RESULTS / "edge_decay.json").exists():
        report["edge_decay"] = orjson.loads((RESULTS / "edge_decay.json").read_bytes())["rows"]
    if do_sweep:
        sw = sweep(stream, cfg, {"trade_model": ["options", "hybrid", "ensemble"], "min_edge": [0.01, 0.02, 0.04],
                                 "band_k": [0.0, 1.0, 2.0]})
        _dump("sweep.json", sw)
        report["sweep"] = sw
    elif (RESULTS / "sweep.json").exists():
        report["sweep"] = orjson.loads((RESULTS / "sweep.json").read_bytes())
    if (RESULTS / "backfill.json").exists():
        report["backfill"] = orjson.loads((RESULTS / "backfill.json").read_bytes())
    report["seconds"] = round(time.time() - t_start, 1)
    _dump("report.json", report)
    return report


# ---------------------------------------------------------------------- figures
def figures(rep: dict[str, Any]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    FIG.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                         "figure.dpi": 150, "axes.grid": True, "grid.alpha": 0.25})
    colors = {"p_options": "#4f46e5", "p_hybrid": "#d97706", "p_realized": "#0d9488", "p_ensemble": "#9333ea",
              "mid": "#64748b", "p_kumo": "#dc2626", "p_dvol": "#4f46e5", "p_rv": "#0d9488", "p_blend": "#d97706"}

    def reliability(models: dict, title: str, path: Path) -> None:
        fig, ax = plt.subplots(figsize=(5.2, 4.6))
        ax.plot([0, 1], [0, 1], color="#94a3b8", lw=1, ls="--", label="perfect")
        for m, v in models.items():
            xs = [b["p_mean"] for b in v["bins"]]
            ys = [b["y_rate"] for b in v["bins"]]
            lab = f"{v.get('label', m)} (Brier {v['brier']:.4f})"
            ax.plot(xs, ys, marker="o", ms=3.5, lw=1.4, color=colors.get(m), label=lab)
        ax.set_xlabel("predicted probability")
        ax.set_ylabel("observed frequency")
        ax.set_title(title, fontsize=10)
        ax.legend(fontsize=7, loc="upper left")
        fig.tight_layout()
        fig.savefig(path)
        plt.close(fig)

    cal = (rep.get("calibration") or {}).get("all")
    if cal and cal.get("models"):
        reliability(cal["models"], f"Recorded data: {cal['n_contracts']} contracts, {cal['n_events']} expiries",
                    FIG / "reliability_recorded.png")
    bf = rep.get("backfill") or {}
    if bf.get("calibration", {}).get("all"):
        b = bf["calibration"]["all"]
        reliability({k: {**v, "label": bf["models"][k]} for k, v in b["models"].items()},
                    f"Kalshi hourly, {b['markets']} markets ({bf.get('period', {}).get('from', '')[:10]} on)",
                    FIG / "reliability_backfill.png")
    if rep.get("edge_decay"):
        d = rep["edge_decay"]
        fig, ax = plt.subplots(figsize=(6, 3.6))
        xs = [max(r["added_ms"], 10) for r in d]
        ax.plot(xs, [r["net"] for r in d], marker="o", color="#d97706", label="net P&L after fees")
        ax.plot(xs, [r["expected_edge"] for r in d], marker=".", color="#94a3b8", ls="--", label="model edge at decision")
        ax.axhline(0, color="#475569", lw=0.8)
        ax.set_xscale("log")
        ax.set_xlabel("added latency (ms, first point = 0)")
        ax.set_ylabel("$")
        ax.set_title("Edge decay: same recorded data, more latency", fontsize=10)
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(FIG / "edge_decay.png")
        plt.close(fig)
    if rep.get("equity_curve"):
        c = rep["equity_curve"]
        fig, ax = plt.subplots(figsize=(6, 3.2))
        ts = [datetime.fromtimestamp(p["t"] / 1000, tz=UTC) for p in c]
        ax.step(ts, [p["equity"] for p in c], where="post", color="#0d9488")
        ax.axhline(rep["config"]["bankroll"], color="#94a3b8", lw=0.8, ls="--")
        ax.set_title("Paper equity (settled P&L after fees, final point marked)", fontsize=10)
        fig.autofmt_xdate()
        fig.tight_layout()
        fig.savefig(FIG / "equity.png")
        plt.close(fig)
    rtt = rep["latency"]["network"]["rtt"]
    if rtt:
        fig, ax = plt.subplots(figsize=(6, 3.2))
        names = sorted(rtt, key=lambda k: rtt[k].get("p50") or 0)
        for i, k in enumerate(names):
            v = rtt[k]
            ax.plot([v["p50"], v["p99"]], [i, i], color="#cbd5e1", lw=6, solid_capstyle="round")
            ax.plot([v["p50"]], [i], "o", color="#d97706")
            ax.plot([v["p95"]], [i], "|", color="#4f46e5", ms=12)
            ax.text(v["p99"], i, f"  p50 {v['p50']:.0f} / p95 {v['p95']:.0f} / p99 {v['p99']:.0f} ms", va="center",
                    fontsize=7)
        ax.set_yticks(range(len(names)), names)
        ax.set_xscale("log")
        ax.set_xlabel("REST round trip from the recorder (ms)")
        ax.set_title("Network round trips (p50 dot, p95 tick, bar to p99)", fontsize=10)
        fig.tight_layout()
        fig.savefig(FIG / "latency.png")
        plt.close(fig)


# ---------------------------------------------------------------------- markdown
def _money(x: float | None) -> str:
    return "n/a" if x is None else f"{'+' if x >= 0 else '-'}${abs(x):,.2f}"


def markdown(rep: dict[str, Any]) -> str:
    s = rep["summary"]
    lines = [
        "# Edge Desk: evaluation report", "",
        f"Generated {rep['generated']} by `uv run python -m edgedesk.eval.report`. Paper trading only; not investment advice.",
        "", "## Data", "",
        f"- Recorded period: **{rep['period']['from']} to {rep['period']['to']}** ({rep['period']['hours']} h), "
        f"{rep['records']:,} raw messages, {rep['contracts']} contracts seen.",
        f"- Resolved contracts: Kalshi {rep['resolved']['kalshi']}, Polymarket {rep['resolved']['polymarket']}.",
        f"- Gaps longer than a minute: {', '.join(f'{g['from']} to {g['to']} ({g['minutes']} min)' for g in rep['gaps']) or 'none'}.",
        f"- Determinism: two replays of the period gave {'the same' if rep['deterministic'] else 'DIFFERENT'} digest "
        f"(`{rep['digest'][:16]}...`).", "",
        "## Paper P&L (default configuration, not tuned)", "",
        f"Model `{rep['config']['trade_model']}`, min edge {rep['config']['min_edge']:.2f} after fees and "
        f"{rep['config']['band_k']:.0f} error band, quarter Kelly on a ${rep['config']['bankroll']:,.0f} paper bankroll, "
        f"one-way latency {rep['config']['latency_ms']} ms (half the measured median round trip).", "",
        "| | value |", "|---|---|",
        f"| Trades (orders with fills) | {s['trades']} ({s['settled']} settled, {s['open']} open) |",
        f"| Contracts bought / capital used | {s['contracts']:,} / ${s['cost']:,.2f} |",
        f"| Gross settled P&L | {_money(s['gross_settled'])} |",
        f"| Fees paid | {_money(-s['fees'])} |",
        f"| **Net P&L after fees** (settled + open marked) | **{_money(s['net_total'])}** |",
        f"| Return on capital used | {('n/a' if s['return_on_cost'] is None else f'{100 * s['return_on_cost']:.2f}%')} |",
        f"| Win rate (settled) | {('n/a' if s['win_rate'] is None else f'{100 * s['win_rate']:.0f}%')} |",
        f"| Max drawdown | {_money(rep['max_drawdown'])} |", "",
        "Attribution of the total (per trade: model edge at decision, minus latency and slippage, minus fees, "
        "plus the difference between what happened and the model probability):", "",
        "| edge at decision | latency | slippage | fees | outcome vs model |", "|---|---|---|---|---|",
        "| " + " | ".join(_money(rep["attribution"]["total"].get(k)) for k in
                         ("edge", "latency", "slippage", "fees", "model_luck")) + " |", "",
        "Same data, other traded models (default thresholds):", "",
        "| model | trades | net after fees | fees |", "|---|---|---|---|",
        *[f"| {m} | {v['trades']} | {_money(v['net_total'])} | {_money(-v['fees'])} |" for m, v in rep["per_model"].items()],
        "",
    ]
    cal = (rep["calibration"] or {}).get("all")
    if cal:
        lines += ["## Calibration on resolved contracts (recorded data)", "",
                  f"{cal['n_snapshots']} snapshots, {cal['n_contracts']} contracts, {cal['n_events']} expiries, base rate "
                  f"{cal['base_rate']}. Lower is better.", "", "| model | Brier | log loss |", "|---|---|---|",
                  *[f"| {v['label']} | {v['brier']:.4f} | {v['log_loss']:.4f} |" for v in cal["models"].values()], "",
                  "![Reliability, recorded data](figures/reliability_recorded.png)", ""]
    bf = rep.get("backfill")
    if bf and bf.get("calibration"):
        a = bf["calibration"]["all"]
        lines += ["## Historical study: a week of Kalshi hourly brackets", "",
                  f"{bf['n_markets']} near-the-money markets in {bf['n_events']} hourly events "
                  f"({(bf.get('period') or {}).get('from', '')} to {(bf.get('period') or {}).get('to', '')}), sampled at "
                  f"{', '.join(str(h) for h in bf['horizons_min'])} minutes before expiry. 1-minute top of book, no depth, "
                  "DVOL as the options proxy (no historical smile).", "",
                  "| horizon | n | " + " | ".join(bf["models"][m] for m in bf["models"]) + " |",
                  "|---|---|" + "---|" * len(bf["models"])]
        for k, v in bf["calibration"].items():
            lines.append(f"| {k} | {v['n']} | " + " | ".join(f"{v['models'][m]['brier']:.4f}" for m in bf["models"]) + " |")
        lines += ["", "Brier scores. Threshold rule at the top of book after the Kalshi taker fee (1 contract per signal, "
                  "decisions at 30 and 15 minutes, hold to settlement; 95% bootstrap interval on P&L per contract):", "",
                  "| model | threshold | trades | P&L / contract | 95% CI | hit rate |", "|---|---|---|---|---|---|"]
        for m, by in bf["strategy"].items():
            for thr, r in by.items():
                if r.get("trades"):
                    lines.append(f"| {bf['models'][m]} | {thr} | {r['trades']} | {r['pnl_per_contract']:+.4f} | "
                                 f"[{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}] | {r['hit_rate']:.2f} |")
        lines += ["", f"Mean DVOL vs mean 1-minute realized vol: {bf.get('vol')}. Median vol implied by Kalshi mids: "
                  f"{bf.get('market_implied_vol_median')}.", "", "![Reliability, backfill](figures/reliability_backfill.png)", ""]
        _ = a
    lat = rep["latency"]
    lines += ["## Latency", "", "| source | n | p50 ms | p95 ms | p99 ms |", "|---|---|---|---|---|",
              *[f"| {k} REST round trip | {v['n']} | {v['p50']:.0f} | {v['p95']:.0f} | {v['p99']:.0f} |"
                for k, v in sorted(lat["network"]["rtt"].items())],
              *[f"| {k} (receive minus exchange stamp) | {v['n']} | {v['p50']:.0f} | {v['p95']:.0f} | {v['p99']:.0f} |"
                for k, v in sorted(lat["network"]["feed_lag"].items()) if v.get("n")], "",
              "Internal hot path per message (µs): " + ", ".join(
                  f"{k} p50 {v['p50']:.1f} / p99 {v['p99']:.1f}" for k, v in lat["hops"].items() if v.get("n")), "",
              "![Latency](figures/latency.png)", ""]
    if rep.get("edge_decay"):
        lines += ["## Edge decay", "", "| added latency | trades | net after fees | model edge at decision | latency cost |",
                  "|---|---|---|---|---|",
                  *[f"| {r['added_ms']:,.0f} ms | {r['trades']} | {_money(r['net'])} | {_money(r['expected_edge'])} | "
                    f"{_money(r['latency_cost'])} |" for r in rep["edge_decay"]], "",
                  "![Edge decay](figures/edge_decay.png)", ""]
    if rep.get("sweep"):
        sw = rep["sweep"]
        b, d = sw["best_in_sample"], sw.get("default") or {}
        lines += ["## Parameter sweep with out-of-sample check", "",
                  f"Chosen on the first half (before {_iso(sw['cut_ms'])}), judged on the second half.", "",
                  "| | model | min edge | bands | train net | test net |", "|---|---|---|---|---|---|",
                  f"| best in-sample | {b['trade_model']} | {b['min_edge']} | {b['band_k']} | {_money(b['train_net'])} | "
                  f"{_money(b['test_net'])} |",
                  f"| default | {d.get('trade_model')} | {d.get('min_edge')} | {d.get('band_k')} | {_money(d.get('train_net'))} | "
                  f"{_money(d.get('test_net'))} |", ""]
    rr = rep.get("risk_of_ruin")
    lines += ["## Risk", "",
              f"- {rep['risk']['decisions']} pre-trade risk decisions, {rep['risk']['recon_checks']} reconciliations "
              f"({'all clean' if rep['risk']['recon_ok'] else 'BREAKS FOUND'}), {rep['risk']['input_rejects']} input "
              "messages rejected by the ingest guard.",
              f"- Halts: {', '.join(h['reason'] for h in rep['risk']['halts']) or 'none'}.",
              (f"- Risk of ruin (bootstrap of {rr['n_source_trades']} trade returns over {rr['n_trades']} trades, ruin = "
               f"-50%): {100 * rr['p_ruin']:.1f}%; median final equity x{rr['final_p50']}. Assumes independent trades: "
               "optimistic." if rr and rr.get("n_source_trades") else "- Risk of ruin: not enough trades."), "",
              "## Caveats", "",
              "- A short recording window: hours to days, one market regime. Calibration snapshots of the same contract "
              "are correlated; read the contract and expiry counts, not the snapshot count.",
              "- Fills are simulated against recorded books (REST snapshots every 10-15 s on Kalshi, WebSocket on "
              "Polymarket) with a 50% depth haircut; we never know our true queue position or market impact.",
              "- Kalshi settles on the CF Benchmarks BRTI 60-second average; Coinbase spot is used as its proxy. "
              "Polymarket settles on the Binance BTC/USDT 1-hour close; Binance spot is used.",
              "- Deribit's shortest listed expiry is the next 08:00 UTC; anything shorter is extrapolated (options model) "
              "or blended with realized vol (hybrid).", ""]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--decay", action="store_true")
    a = ap.parse_args()
    rep = build(a.sweep, a.decay)
    figures(rep)
    (ROOT / "eval" / "report.md").write_text(markdown(rep))
    s = rep["summary"]
    print(f"period {rep['period']} resolved {rep['resolved']} trades {s['trades']} net {s['net_total']} "
          f"fees {s['fees']} deterministic {rep['deterministic']} in {rep['seconds']}s")


if __name__ == "__main__":
    main()
