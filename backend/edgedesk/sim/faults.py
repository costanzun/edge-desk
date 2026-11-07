"""Fault injection on a raw record stream (seeded, so faulted runs are reproducible too).

Each fault mimics something real feeds do: dropped messages or whole connection gaps,
late delivery, duplicates, out-of-order arrival, malformed payloads, venue 429/5xx
bursts, and an exchange clock that runs ahead of ours.
"""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass


@dataclass
class Faults:
    seed: int = 1
    drop: float = 0.0            # drop individual records
    gap_s: float = 0.0           # one connection gap of this length per venue, mid-stream
    duplicate: float = 0.0       # deliver a record twice
    reorder: float = 0.0         # swap with a neighbour (arrival order != receive time)
    delay_s: float = 0.0         # deliver late: receive time pushed back, exchange time kept
    delay_p: float = 0.0
    malformed: float = 0.0       # corrupt payload fields
    errors_429: int = 0          # bursts of venue error records
    skew_ms: float = 0.0         # exchange clock ahead by this much (records with t_exch)
    skew_p: float = 0.0


def inject(recs: list[dict], f: Faults) -> list[dict]:
    rng = random.Random(f.seed)
    out: list[dict] = []
    if not recs:
        return out
    t_first, t_last = recs[0]["t_recv"], recs[-1]["t_recv"]
    gap_at = t_first + (t_last - t_first) // 2
    gap_ns = int(f.gap_s * 1e9)
    for r in recs:
        if f.gap_s and r["src"] in ("kalshi", "polymarket") and gap_at <= r["t_recv"] < gap_at + gap_ns:
            continue
        if f.drop and rng.random() < f.drop and r["kind"] not in ("event", "outcome"):
            continue
        r = copy.deepcopy(r)
        if f.malformed and rng.random() < f.malformed:
            _corrupt(r, rng)
        if f.skew_p and r.get("t_exch") and rng.random() < f.skew_p:
            r["t_exch"] = int(r["t_exch"] + f.skew_ms)
            for k in ("ts",):
                if isinstance(r["data"], dict) and r["data"].get(k):
                    r["data"][k] = int(r["data"][k] + f.skew_ms)
        if f.delay_p and rng.random() < f.delay_p:
            r["t_recv"] += int(f.delay_s * 1e9)
        out.append(r)
        if f.duplicate and rng.random() < f.duplicate:
            out.append(copy.deepcopy(r))
    if f.reorder:
        for i in range(len(out) - 1):
            if rng.random() < f.reorder:
                out[i], out[i + 1] = out[i + 1], out[i]
    for _ in range(f.errors_429):
        t = rng.randint(t_first, t_last)
        venue = rng.choice(["kalshi", "polymarket"])
        for j in range(3):
            out.append({"seq": 10**9 + rng.randint(0, 10**8), "src": venue, "kind": "error",
                        "t_recv": t + j * 1_000_000_000, "t_exch": None, "rtt_ms": None,
                        "data": {"error": "HttpError: 429 Too Many Requests", "status": 429}})
    if f.delay_p or f.errors_429:
        # the reader orders by receive time; reordering faults are applied after that on purpose
        if not f.reorder:
            out.sort(key=lambda r: (r["t_recv"], r["seq"]))
    return out


def _corrupt(r: dict, rng: random.Random) -> None:
    d = r.get("data")
    if not isinstance(d, dict):
        return
    choice = rng.randint(0, 5)
    if choice == 0 and "bid" in d:
        d["bid"] = "NaN"
    elif choice == 1 and "rows" in d:
        d["rows"] = [[None] * 3 for _ in range(len(d["rows"]))] if d["rows"] else "garbage"
    elif choice == 2 and "bids" in d:
        d["bids"] = [[1.7, -5.0]]
    elif choice == 3 and "asks" in d:
        d["asks"] = [[0.5, 10.0], [0.4, 10.0]]  # not sorted
    elif choice == 4 and "price" in d:
        d["price"] = -1
    else:
        r["data"] = None  # whole payload missing
