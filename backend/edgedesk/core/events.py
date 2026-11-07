"""Events and the append-only event log.

Everything the engine sees or does is an ``Event``: market data, model outputs, signals,
order transitions, fills, risk decisions, settlements, halts. State is a fold over these.

The log keeps a rolling SHA-256 over the canonical JSON of every event. Two runs over the
same input with the same config must end with the same digest: that is the determinism
check (bit-for-bit, including floats, because orjson serialises floats with shortest
round-trip repr).
"""

from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import orjson

# Market data (inputs)
MD_CONTRACT = "md.contract"   # contract definition (venue, id, underlying, strike, expiry, reference)
MD_BOOK = "md.book"           # YES-side order book snapshot for a contract
MD_SPOT = "md.spot"           # spot quote from an exchange
MD_INDEX = "md.index"         # Deribit index price
MD_CHAIN = "md.chain"         # Deribit option chain snapshot
MD_OUTCOME = "md.outcome"     # contract resolved YES/NO
MD_FEED_ERROR = "md.feed_error"
CONTROL = "control"           # operator action (kill switch, resume), replayable

# Engine outputs
MODEL = "model"
SIGNAL = "signal"
RISK = "risk"
ORDER = "order"               # order state transition
FILL = "fill"
SETTLE = "settle"
RECON = "recon"
HALT = "halt"
FEED = "feed"                 # feed health transition
REJECT_INPUT = "input.reject" # malformed / duplicate / stale input dropped by the ingest guard


class Event:
    __slots__ = ("data", "kind", "seq", "t")

    def __init__(self, seq: int, t: int, kind: str, data: dict[str, Any]) -> None:
        self.seq = seq
        self.t = t          # ns since epoch, *event time* (never wall-clock inside the engine)
        self.kind = kind
        self.data = data

    def to_json(self) -> bytes:
        return orjson.dumps({"seq": self.seq, "t": self.t, "kind": self.kind, "data": self.data},
                            option=orjson.OPT_SORT_KEYS)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Event({self.seq}, {self.t}, {self.kind}, {self.data})"


class EventLog:
    """Append-only, sequence-numbered, hash-chained log of engine events."""

    def __init__(self, path: Path | None = None, keep: bool = True, keep_kinds: set[str] | None = None) -> None:
        self.seq = 0
        self._h = hashlib.sha256()
        self.counts: Counter[str] = Counter()
        self.events: list[Event] = []
        self._keep = keep
        self._keep_kinds = keep_kinds
        self._fh = open(path, "wb") if path else None

    def append(self, t: int, kind: str, data: dict[str, Any]) -> Event:
        self.seq += 1
        ev = Event(self.seq, t, kind, data)
        line = ev.to_json()
        self._h.update(line)
        self.counts[kind] += 1
        if self._keep and (self._keep_kinds is None or kind in self._keep_kinds):
            self.events.append(ev)
        if self._fh:
            self._fh.write(line + b"\n")
        return ev

    @property
    def digest(self) -> str:
        return self._h.hexdigest()

    def of(self, *kinds: str) -> list[Event]:
        return [e for e in self.events if e.kind in kinds]

    def close(self) -> None:
        if self._fh:
            self._fh.close()
            self._fh = None


def read_log(path: Path) -> Iterable[Event]:
    with open(path, "rb") as fh:
        for line in fh:
            d = orjson.loads(line)
            yield Event(d["seq"], d["t"], d["kind"], d["data"])
