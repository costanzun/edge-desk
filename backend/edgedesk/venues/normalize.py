"""Venue parsers: raw recorder records -> normalized market-data events.

The normalizer is the read-only "adapter" layer for every venue. It is deterministic and
stateful only in ways that are themselves a function of the input (contract registry,
last book per contract so unchanged snapshots are not re-emitted, as a delta feed would).

Book convention: every contract has one YES book. ``bids`` are YES bids, best first
(descending), ``asks`` are YES asks, best first (ascending). Buying NO at price q is the
same as hitting a YES bid at 1-q, so the NO side is derived, never stored.
"""

from __future__ import annotations

from typing import Any, Iterator

from edgedesk.core import events as E

KALSHI_REF = "CF BRTI, 60 s average before expiry"
POLY_REF = "Binance BTC/USDT 1h candle close"

Raw = dict[str, Any]
Out = tuple[int, str, dict[str, Any]]  # (t_ns, kind, data)


def _levels(xs: list) -> list[list[float]]:
    return [[float(p), float(q)] for p, q in xs if q and float(q) > 0]


class Normalizer:
    def __init__(self) -> None:
        self.contracts: dict[str, dict] = {}        # cid -> contract
        self.poly_by_market: dict[str, str] = {}    # gamma market id -> cid (yes token)
        self._last_book: dict[str, tuple] = {}
        self._depth_t: dict[str, int] = {}

    # ------------------------------------------------------------------ public
    def __call__(self, rec: Raw) -> Iterator[Out]:
        src, kind, t, d = rec["src"], rec["kind"], rec["t_recv"], rec["data"]
        fn = getattr(self, f"_{src}_{kind}", None)
        if kind == "error":
            yield t, E.MD_FEED_ERROR, {"src": src, "error": d.get("error"), "status": d.get("status"),
                                       "rseq": rec["seq"]}
            return
        if fn is None:
            return
        for kind_, data in fn(rec, d):
            data.setdefault("rseq", rec["seq"])
            yield t, kind_, data

    # ------------------------------------------------------------------ helpers
    def _contract(self, c: dict) -> Iterator[tuple[str, dict]]:
        if c["cid"] not in self.contracts:
            self.contracts[c["cid"]] = c
            yield E.MD_CONTRACT, dict(c)

    def _book(self, venue: str, cid: str, bids: list, asks: list, t_exch: int | None, depth: bool,
              rec: Raw) -> Iterator[tuple[str, dict]]:
        key = (tuple(map(tuple, bids)), tuple(map(tuple, asks)))
        if self._last_book.get(cid) == key:
            return
        self._last_book[cid] = key
        yield E.MD_BOOK, {"venue": venue, "cid": cid, "bids": bids, "asks": asks, "t_exch": t_exch,
                          "depth": depth, "rtt_ms": rec.get("rtt_ms")}

    # ------------------------------------------------------------------ spot / deribit
    def _coinbase_spot(self, rec: Raw, d: dict):
        if d.get("bid") and d.get("ask"):
            yield E.MD_SPOT, {"src": "coinbase", "sym": d["sym"], "bid": d["bid"], "ask": d["ask"],
                              "t_exch": rec.get("t_exch"), "rtt_ms": rec.get("rtt_ms")}

    def _binance_spot(self, rec: Raw, d: dict):
        if d.get("bid") and d.get("ask"):
            yield E.MD_SPOT, {"src": "binance", "sym": d["sym"], "bid": d["bid"], "ask": d["ask"],
                              "t_exch": rec.get("t_exch"), "rtt_ms": rec.get("rtt_ms")}

    def _binance_kline_1h(self, rec: Raw, d: dict):
        for open_ms, _o, close, close_ms in d.get("rows", []):
            yield "md.kline", {"src": "binance", "sym": d["sym"], "open_ms": open_ms,
                               "close_ms": close_ms + 1, "close": close}

    def _deribit_index(self, rec: Raw, d: dict):
        yield E.MD_INDEX, {"sym": d["sym"], "price": d["price"], "t_exch": rec.get("t_exch"),
                           "rtt_ms": rec.get("rtt_ms")}

    def _deribit_chain(self, rec: Raw, d: dict):
        cols = d["cols"]
        ix = {c: i for i, c in enumerate(cols)}
        rows = []
        for r in d["rows"]:
            iv = r[ix["mark_iv"]]
            if iv is None or iv <= 0 or r[ix["und"]] is None:
                continue
            rows.append([r[ix["exp_ms"]], r[ix["strike"]], r[ix["cp"]], iv / 100.0, r[ix["und"]],
                         r[ix["bid"]], r[ix["ask"]], r[ix["mark"]]])
        if rows:
            yield E.MD_CHAIN, {"sym": d["sym"], "rows": rows, "t_exch": rec.get("t_exch"),
                               "rtt_ms": rec.get("rtt_ms")}

    # ------------------------------------------------------------------ kalshi
    def _kalshi_event(self, rec: Raw, d: dict):
        return iter(())

    def _kalshi_markets(self, rec: Raw, d: dict):
        ix = {c: i for i, c in enumerate(d["cols"])}
        for r in d["rows"]:
            cid, strike, typ = r[ix["ticker"]], r[ix["strike"]], r[ix["type"]]
            if strike is None or typ != "greater":
                continue
            yield from self._contract({"venue": "kalshi", "cid": cid, "sym": d["sym"], "strike": strike,
                                       "expiry_ms": d["close_ms"], "ref": KALSHI_REF, "group": d["event"],
                                       "tick": 0.01, "min_size": 1.0})
            if r[ix["status"]] != "active":
                continue
            yb, ya = r[ix["yes_bid"]], r[ix["yes_ask"]]
            bsz, asz = r[ix["yes_bid_sz"]] or 0.0, r[ix["yes_ask_sz"]] or 0.0
            bids = [[yb, bsz]] if yb and yb > 0 and bsz > 0 else []
            asks = [[ya, asz]] if ya and ya < 1 and asz > 0 else []
            last = self._last_book.get(cid)
            if last is not None and self._depth_t.get(cid, 0) > rec["t_recv"] - 30_000_000_000:
                top_b = list(last[0][0]) if last[0] else []
                top_a = list(last[1][0]) if last[1] else []
                if (top_b[:1] == [yb] if bids else not top_b) and (top_a[:1] == [ya] if asks else not top_a):
                    continue  # top unchanged: keep the richer depth book we already have
            yield from self._book("kalshi", cid, bids, asks, None, False, rec)

    def _kalshi_book(self, rec: Raw, d: dict):
        cid = d["ticker"]
        if cid not in self.contracts:
            return
        bids = sorted(_levels(d.get("yes", [])), key=lambda x: -x[0])
        asks = sorted(([round(1 - p, 4), q] for p, q in _levels(d.get("no", []))), key=lambda x: x[0])
        self._depth_t[cid] = rec["t_recv"]
        yield from self._book("kalshi", cid, bids, asks, None, True, rec)

    def _kalshi_outcome(self, rec: Raw, d: dict):
        ix = {c: i for i, c in enumerate(d["cols"])}
        for r in d["rows"]:
            cid = r[ix["ticker"]]
            if cid in self.contracts and r[ix["result"]] in ("yes", "no"):
                yield E.MD_OUTCOME, {"venue": "kalshi", "cid": cid, "yes": r[ix["result"]] == "yes",
                                     "value": r[ix["settle_value"]], "source": "venue"}

    # ------------------------------------------------------------------ polymarket
    def _polymarket_event(self, rec: Raw, d: dict):
        for m in d.get("markets", []):
            cid = m["yes_token"]
            self.poly_by_market[str(m.get("market_id"))] = cid
            fee = m.get("fee") or {}
            yield from self._contract({"venue": "polymarket", "cid": cid, "sym": d["sym"], "strike": m["strike"],
                                       "expiry_ms": d["end_ms"], "ref": POLY_REF, "group": d["slug"],
                                       "tick": m.get("tick") or 0.01, "min_size": m.get("min_size") or 5.0,
                                       "fee_rate": fee.get("rate"), "fee_exp": fee.get("exponent")})

    def _polymarket_books(self, rec: Raw, d: dict):
        for b in d.get("books", []):
            cid = b.get("token")
            if cid not in self.contracts:
                continue
            yield from self._book("polymarket", cid, _levels(b.get("bids", [])), _levels(b.get("asks", [])),
                                  b.get("ts") or None, True, rec)

    def _polymarket_outcome(self, rec: Raw, d: dict):
        ix = {c: i for i, c in enumerate(d["cols"])}
        for r in d["rows"]:
            cid = self.poly_by_market.get(str(r[ix["market_id"]]))
            if cid and r[ix["yes_price"]] in (0.0, 1.0):
                yield E.MD_OUTCOME, {"venue": "polymarket", "cid": cid, "yes": r[ix["yes_price"]] == 1.0,
                                     "value": None, "source": "venue"}
