from datetime import UTC, datetime

from edgedesk.eval.backfill import _ts_close, analyse, strategy


def _utc(ts):
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d %H:%M")


def test_ticker_close_handles_timezone_suffixes():
    # regression: "unconverted data remains: EST"
    assert _utc(_ts_close("KXBTCD-26NOV0517EST")) == "2026-11-05 22:00"   # EST = UTC-5
    assert _utc(_ts_close("KXBTCD-26NOV0517")) == "2026-11-05 22:00"
    assert _utc(_ts_close("KXBTCD-26OCT2717EDT")) == "2026-10-27 21:00"   # EDT = UTC-4


def test_strategy_and_analysis_on_tiny_sample():
    rows = []
    for i in range(40):
        y = float(i % 2)
        rows.append({"sym": "BTC", "event": f"E{i // 4}", "ticker": f"T{i}", "h": 30, "strike": 100.0, "close": 1_794_000_000 + i,
                     "spot": 100.0, "bid": 0.45, "ask": 0.47, "mid": 0.46, "y": y, "dvol": 0.4, "rv": 0.4,
                     "p_dvol": 0.6, "p_rv": 0.55, "p_blend": 0.57})
    s = strategy(rows, "p_dvol", 0.02)
    assert s["trades"] == 40 and s["ci95"][0] <= s["pnl_per_contract"] <= s["ci95"][1]
    res = analyse(rows)
    assert res["n_markets"] == 40 and "all" in res["calibration"]
