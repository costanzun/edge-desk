"""Ingest guard: nothing reaches engine state without passing here.

Drops (and logs) malformed, duplicate and out-of-order messages; tracks feed health
(venue errors, clock skew, delayed data) so the risk engine can refuse to trade on a
feed that is not trustworthy right now. Recovery is automatic after N clean messages.
"""

from __future__ import annotations

import math
from collections import deque

from edgedesk.core import events as E

SKEW_FUTURE_MS = 2_000      # exchange timestamp ahead of our receive clock
DELAY_MS = 30_000           # message older than this on arrival
RECOVER_AFTER = 5           # clean messages needed to clear a degraded feed
ERROR_WINDOW_NS = 60 * 1_000_000_000
ERRORS_TO_DEGRADE = 2


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _levels_ok(levels, descending: bool) -> bool:
    if not isinstance(levels, list):
        return False
    prev = None
    for lv in levels:
        if not (isinstance(lv, (list, tuple)) and len(lv) == 2 and _finite(lv[0]) and _finite(lv[1])):
            return False
        p, q = lv
        if not (0.0 < p < 1.0) or q <= 0:
            return False
        if prev is not None and ((p >= prev) if descending else (p <= prev)):
            return False
        prev = p
    return True


def validate(kind: str, d: dict) -> str | None:
    """Return a reason string if the message is malformed, else None."""
    try:
        if kind == E.MD_BOOK:
            if not isinstance(d.get("cid"), str):
                return "book without contract id"
            if not _levels_ok(d.get("bids"), True) or not _levels_ok(d.get("asks"), False):
                return "bad book levels"
            if d["bids"] and d["asks"] and d["bids"][0][0] >= d["asks"][0][0]:
                return "crossed book"
        elif kind == E.MD_SPOT:
            if not (_finite(d.get("bid")) and _finite(d.get("ask")) and 0 < d["bid"] <= d["ask"]):
                return "bad spot quote"
            if d["ask"] / d["bid"] - 1 > 0.01:
                return "spot spread > 1%"
        elif kind == E.MD_INDEX:
            if not (_finite(d.get("price")) and d["price"] > 0):
                return "bad index price"
        elif kind == E.MD_CHAIN:
            rows = d.get("rows")
            if not isinstance(rows, list) or not rows:
                return "empty chain"
            for r in rows:
                if len(r) < 5 or not all(_finite(x) for x in (r[0], r[1], r[3], r[4])) or not (0 < r[3] < 5):
                    return "bad chain row"
        elif kind == E.MD_CONTRACT:
            if not (_finite(d.get("strike")) and _finite(d.get("expiry_ms")) and d.get("cid")):
                return "bad contract"
        elif kind == E.MD_OUTCOME:
            if not isinstance(d.get("yes"), bool) or not d.get("cid"):
                return "bad outcome"
    except (TypeError, KeyError, IndexError, ZeroDivisionError):
        return "unparseable"
    return None


FEED_OF = {E.MD_BOOK: lambda d: d.get("venue"), E.MD_SPOT: lambda d: d.get("src"),
           E.MD_INDEX: lambda d: "deribit", E.MD_CHAIN: lambda d: "deribit"}


class FeedState:
    __slots__ = ("clean", "errors", "last_t", "ok", "reason")

    def __init__(self) -> None:
        self.ok = True
        self.reason = ""
        self.clean = 0
        self.errors: deque[int] = deque()
        self.last_t = 0


class IngestGuard:
    def __init__(self, log_fn) -> None:
        self.log = log_fn          # (t, kind, data) -> None
        self.t = 0                 # last accepted event time
        self._seen: set[int] = set()
        self._seen_q: deque[int] = deque()
        self.feeds: dict[str, FeedState] = {}
        self._book_exch: dict[str, int] = {}
        self.rejected = 0

    def feed(self, name: str) -> FeedState:
        if name not in self.feeds:
            self.feeds[name] = FeedState()
        return self.feeds[name]

    def _reject(self, t: int, kind: str, d: dict, reason: str) -> bool:
        self.rejected += 1
        self.log(max(t, self.t), E.REJECT_INPUT, {"kind": kind, "reason": reason, "rseq": d.get("rseq"),
                                                 "cid": d.get("cid"), "src": d.get("src") or d.get("venue")})
        return False

    def _degrade(self, t: int, name: str, reason: str) -> None:
        fs = self.feed(name)
        fs.clean = 0
        if fs.ok:
            fs.ok, fs.reason = False, reason
            self.log(t, E.FEED, {"feed": name, "ok": False, "reason": reason})

    def _clean(self, t: int, name: str) -> None:
        fs = self.feed(name)
        fs.last_t = t
        if not fs.ok:
            fs.clean += 1
            if fs.clean >= RECOVER_AFTER:
                fs.ok, fs.reason = True, ""
                self.log(t, E.FEED, {"feed": name, "ok": True, "reason": "recovered"})

    def admit(self, t: int, kind: str, d: dict) -> bool:
        rseq = d.get("rseq")
        if t < self.t:
            return self._reject(t, kind, d, "out of order (event time went backwards)")
        if kind == E.CONTROL:
            self.t = t
            return True
        if isinstance(rseq, int) and kind != E.MD_CONTRACT:
            # one raw record can yield several events (e.g. a book per strike): key on all three
            key = (rseq, kind, d.get("cid") or d.get("sym"))
            if key in self._seen:
                return self._reject(t, kind, d, "duplicate")
            self._seen.add(key)
            self._seen_q.append(key)
            if len(self._seen_q) > 200_000:
                self._seen.discard(self._seen_q.popleft())
        if kind == E.MD_FEED_ERROR:
            fs = self.feed(d.get("src", "?"))
            fs.errors.append(t)
            while fs.errors and fs.errors[0] < t - ERROR_WINDOW_NS:
                fs.errors.popleft()
            if len(fs.errors) >= ERRORS_TO_DEGRADE:
                self._degrade(t, d.get("src", "?"), f"venue errors: {d.get('error')}")
            self.t = t
            return True
        bad = validate(kind, d)
        if bad:
            name = FEED_OF.get(kind, lambda _d: None)(d)
            if name:
                self.feed(name).clean = 0
            return self._reject(t, kind, d, bad)
        name = FEED_OF.get(kind, lambda _d: None)(d)
        t_exch = d.get("t_exch")
        if name and _finite(t_exch):
            lag_ms = t / 1e6 - t_exch
            if lag_ms < -SKEW_FUTURE_MS:
                self._degrade(t, name, f"clock skew: exchange time {-lag_ms:.0f} ms ahead")
                return self._reject(t, kind, d, "clock skew")
            if kind == E.MD_INDEX and lag_ms > DELAY_MS:  # only Deribit stamps send time
                self._degrade(t, name, f"delayed data: {lag_ms / 1000:.0f} s old")
                return self._reject(t, kind, d, "delayed")
            if kind == E.MD_BOOK:
                prev = self._book_exch.get(d["cid"])
                if prev is not None and t_exch < prev:
                    return self._reject(t, kind, d, "stale book (older exchange timestamp)")
                self._book_exch[d["cid"]] = t_exch
        if name:
            self._clean(t, name)
        self.t = t
        return True
