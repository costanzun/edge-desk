"""KumoRFM (now NVIDIA "Kumo Relational") as an experimental probability model.

Off by default. Runs only when the setting is on AND ``KUMO_API_KEY`` is set in ``.env``;
the rest of the system never depends on it. Nothing is sent anywhere otherwise.

What it does: turn the event log into a small relational database and ask a relational
foundation model to predict each open contract's outcome in-context, learning from the
contracts that have already resolved:

    markets(cid PK, venue, sym, strike, expiry, outcome)      outcome = 1/0, null if open
    snapshots(sid PK, cid FK -> markets, t, tte_s, moneyness, mid, bid, ask,
              p_options, p_hybrid, p_realized)                   time column t

    PREDICT markets.outcome = 1 FOR markets.cid IN (...)   at anchor time t

Only these derived numbers leave the machine (no keys, no account data). Backends:
  - "kumoai": the ``kumoai`` package's RFM API (``rfm.init(api_key=KUMO_API_KEY)``).
  - "sdm":    NVIDIA's ``structured-data-models-client`` (``sdm_client``) against
              ``KUMO_URL`` (a self-hosted NIM or gateway; needs Linux for the engine).
Both are imported lazily; if neither is installed the status says so.
"""

from __future__ import annotations

import os
from typing import Any, Protocol

from edgedesk.core import events as E

LAST_RUN: dict[str, Any] = {}


def api_key() -> str | None:
    return os.environ.get("KUMO_API_KEY") or None


def backend_name() -> str:
    return os.environ.get("KUMO_BACKEND", "kumoai")


def status(enabled: bool) -> dict[str, Any]:
    key = api_key()
    return {"enabled": bool(enabled), "available": key is not None, "active": bool(enabled and key),
            "backend": backend_name(), "last_run": {k: v for k, v in LAST_RUN.items() if k != "predictions"},
            "message": ("Set KUMO_API_KEY in .env to enable (see README: KumoRFM)" if not key else
                        "Enabled: predictions appear as p_kumo in Models" if enabled else
                        "Key found; switch it on in Settings")}


# ---------------------------------------------------------------------- tables
def build_tables(eng, anchor_ns: int, max_snapshots_per_market: int = 30) -> tuple[list[dict], list[dict]]:
    """Markets and snapshots known at ``anchor_ns`` (no look-ahead: outcomes after the anchor
    are hidden, snapshots after the anchor are dropped)."""
    resolved_at = {ev.data["cid"]: ev.t for ev in eng.log.of(E.MD_OUTCOME)}
    markets = {}
    snaps: dict[str, list[dict]] = {}
    for ev in eng.log.of(E.MODEL):
        if ev.t > anchor_ns:
            break
        d = ev.data
        cid = d["cid"]
        if cid not in markets:
            out = eng.outcomes.get(cid)
            known = out is not None and resolved_at.get(cid, d["expiry_ms"] * 1_000_000) <= anchor_ns
            markets[cid] = {"cid": cid, "venue": d["venue"], "sym": d["sym"], "strike": d["strike"],
                            "expiry": d["expiry_ms"], "outcome": (1 if out else 0) if known else None}
        mny = (d["spot"] / d["strike"] - 1) if d.get("spot") else None
        snaps.setdefault(cid, []).append({"sid": f"{cid}:{ev.seq}", "cid": cid, "t": ev.t // 1_000_000,
                                          "tte_s": d["tte_s"], "moneyness": mny, "mid": d.get("mid"),
                                          "bid": d.get("bid"), "ask": d.get("ask"), "p_options": d.get("p_options"),
                                          "p_hybrid": d.get("p_hybrid"), "p_realized": d.get("p_realized")})
    snapshots = [s for v in snaps.values() for s in v[-max_snapshots_per_market:]]
    return list(markets.values()), snapshots


def query_for(cids: list[str]) -> str:
    ids = ", ".join(f"'{c}'" for c in cids)
    return f"PREDICT markets.outcome = 1 FOR markets.cid IN ({ids})"


# ---------------------------------------------------------------------- clients
class Client(Protocol):
    def predict(self, markets: list[dict], snapshots: list[dict], cids: list[str],
                anchor_ms: int) -> dict[str, float]: ...


class KumoaiClient:
    """Legacy ``kumoai`` RFM API (reads KUMO_API_KEY)."""

    def __init__(self, key: str) -> None:
        from kumoai.experimental import rfm  # type: ignore[import-not-found]
        self.rfm = rfm
        rfm.init(api_key=key)

    def predict(self, markets, snapshots, cids, anchor_ms):
        import pandas as pd
        rfm = self.rfm
        dfm = pd.DataFrame(markets)
        dfs = pd.DataFrame(snapshots)
        dfs["t"] = pd.to_datetime(dfs["t"], unit="ms", utc=True)
        graph_cls = getattr(rfm, "LocalGraph", None) or rfm.Graph
        graph = graph_cls.from_data({"markets": dfm, "snapshots": dfs})
        model = rfm.KumoRFM(graph)
        df = model.predict(query_for(cids), anchor_time=pd.Timestamp(anchor_ms, unit="ms", tz="UTC"))
        return _probs_from_frame(df)


class SdmClient:
    """NVIDIA structured-data-models client (Kumo Relational) against KUMO_URL."""

    def __init__(self, key: str) -> None:
        from sdm_client import KumoRelational, PredictiveQuery, Schema, SDMClient  # type: ignore[import-not-found]
        self.mods = (KumoRelational, PredictiveQuery, Schema, SDMClient)
        self.key = key
        self.url = os.environ.get("KUMO_URL", "http://localhost:8000")

    def predict(self, markets, snapshots, cids, anchor_ms):
        import pandas as pd
        KumoRelational, PredictiveQuery, Schema, SDMClient = self.mods
        dfs = pd.DataFrame(snapshots)
        dfs["t"] = pd.to_datetime(dfs["t"], unit="ms", utc=True)
        schema = Schema.from_data({"markets": pd.DataFrame(markets), "snapshots": dfs},
                                  primary_keys={"markets": "cid", "snapshots": "sid"},
                                  time_columns={"snapshots": "t"})
        req = PredictiveQuery(query_for(cids), schema).materialize(
            anchor_time=pd.Timestamp(anchor_ms, unit="ms", tz="UTC"))
        with SDMClient(url=self.url, api_key=self.key) as c:
            df = c.predict(req, model=KumoRelational()).to_pandas()
        return _probs_from_frame(df)


def _probs_from_frame(df) -> dict[str, float]:
    cols = list(df.columns)
    id_col = next((c for c in cols if c.lower() in ("cid", "entity", "markets.cid", "index")), cols[0])
    p_col = next((c for c in cols if c.lower() in ("true_prob", "probability_1", "probability_true",
                                                    "probability", "prob")), None)
    if p_col is None:
        p_col = next(c for c in cols if "prob" in c.lower())
    return {str(r[id_col]): float(r[p_col]) for _, r in df.iterrows()}


def make_client() -> Client:
    key = api_key()
    if not key:
        raise RuntimeError("KUMO_API_KEY is not set")
    return SdmClient(key) if backend_name() == "sdm" else KumoaiClient(key)


# ---------------------------------------------------------------------- run
def predict_open(eng, client: Client | None = None, anchor_ns: int | None = None,
                 max_markets: int = 200) -> dict[str, Any]:
    """Predict the outcome of every contract open at the anchor; store p_kumo on the engine's
    model snapshots so calibration picks it up once the contracts resolve."""
    anchor_ns = anchor_ns or eng.t
    markets, snapshots = build_tables(eng, anchor_ns)
    open_ids = [m["cid"] for m in markets if m["outcome"] is None and m["expiry"] * 1_000_000 > anchor_ns][:max_markets]
    labelled = sum(1 for m in markets if m["outcome"] is not None)
    res: dict[str, Any] = {"anchor_ms": anchor_ns // 1_000_000, "markets": len(markets), "labelled": labelled,
                           "snapshots": len(snapshots), "requested": len(open_ids)}
    if not open_ids or labelled < 10:
        res["error"] = "not enough resolved markets for in-context learning (need 10)"
        LAST_RUN.update(res)
        return res
    try:
        client = client or make_client()
        probs = client.predict(markets, snapshots, open_ids, anchor_ns // 1_000_000)
    except Exception as e:  # noqa: BLE001 - an optional model must never break the desk
        res["error"] = f"{type(e).__name__}: {e}"[:300]
        LAST_RUN.update(res)
        return res
    attach(eng, probs, anchor_ns)
    res["predictions"] = probs
    res["returned"] = len(probs)
    LAST_RUN.clear()
    LAST_RUN.update(res)
    return res


def attach(eng, probs: dict[str, float], anchor_ns: int) -> None:
    """Write p_kumo onto the latest model snapshot at or before the anchor for each contract."""
    latest: dict[str, Any] = {}
    for ev in eng.log.of(E.MODEL):
        if ev.t <= anchor_ns and ev.data["cid"] in probs:
            latest[ev.data["cid"]] = ev
    for cid, ev in latest.items():
        ev.data["p_kumo"] = max(0.0, min(1.0, probs[cid]))
