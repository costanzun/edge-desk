from edgedesk.core import events as E
from edgedesk.core.guard import RECOVER_AFTER, IngestGuard, validate
from edgedesk.venues.normalize import Normalizer

NS = 1_000_000_000


def _guard():
    logged = []
    return IngestGuard(lambda t, k, d: logged.append((t, k, d))), logged


def book(cid="c", bids=([0.4, 10.0],), asks=([0.45, 10.0],), **kw):
    return {"venue": "polymarket", "cid": cid, "bids": [list(b) for b in bids], "asks": [list(a) for a in asks], **kw}


def test_validate_catches_malformed_books():
    assert validate(E.MD_BOOK, book()) is None
    assert validate(E.MD_BOOK, book(bids=([1.2, 5.0],))) == "bad book levels"
    assert validate(E.MD_BOOK, book(asks=([0.5, 1.0], [0.4, 1.0]))) == "bad book levels"
    assert validate(E.MD_BOOK, book(bids=([0.5, 1.0],), asks=([0.45, 1.0],))) == "crossed book"
    assert validate(E.MD_SPOT, {"bid": "NaN", "ask": 1.0}) == "bad spot quote"
    assert validate(E.MD_CHAIN, {"rows": []}) == "empty chain"


def test_duplicates_and_out_of_order_rejected():
    g, logged = _guard()
    assert g.admit(10 * NS, E.MD_BOOK, book(rseq=1))
    assert not g.admit(10 * NS, E.MD_BOOK, book(rseq=1))
    assert not g.admit(9 * NS, E.MD_BOOK, book(rseq=2))
    reasons = [d["reason"] for _, k, d in logged if k == E.REJECT_INPUT]
    assert reasons == ["duplicate", "out of order (event time went backwards)"]


def test_stale_exchange_timestamp_rejected():
    g, _ = _guard()
    assert g.admit(10 * NS, E.MD_BOOK, book(rseq=1, t_exch=9_900))
    assert not g.admit(11 * NS, E.MD_BOOK, book(rseq=2, t_exch=9_800))


def test_clock_skew_degrades_feed_until_clean_messages():
    g, logged = _guard()
    assert not g.admit(10 * NS, E.MD_BOOK, book(rseq=1, t_exch=10_000 + 5_000))
    assert not g.feed("polymarket").ok
    for i in range(RECOVER_AFTER):
        assert g.admit((11 + i) * NS, E.MD_BOOK, book(rseq=2 + i, t_exch=(11 + i) * 1000 - 50))
    assert g.feed("polymarket").ok
    feed_events = [d for _, k, d in logged if k == E.FEED]
    assert feed_events[0]["ok"] is False and feed_events[-1]["ok"] is True


def test_venue_errors_degrade_feed():
    g, _ = _guard()
    g.admit(1 * NS, E.MD_FEED_ERROR, {"src": "kalshi", "error": "429", "rseq": 1})
    assert g.feed("kalshi").ok
    g.admit(2 * NS, E.MD_FEED_ERROR, {"src": "kalshi", "error": "429", "rseq": 2})
    assert not g.feed("kalshi").ok


def test_kalshi_book_no_bids_become_yes_asks():
    n = Normalizer()
    mk = {"seq": 1, "src": "kalshi", "kind": "markets", "t_recv": 1, "data": {
        "event": "E", "sym": "BTC", "close_ms": 10**13, "cols": ["ticker", "strike", "cap", "type", "yes_bid",
                                                                 "yes_ask", "yes_bid_sz", "yes_ask_sz", "last",
                                                                 "volume", "oi", "status"],
        "rows": [["T1", 75000.0, None, "greater", 0.40, 0.45, 10.0, 20.0, None, 0, 0, "active"]]}}
    out = list(n(mk))
    assert [k for _, k, _ in out] == [E.MD_CONTRACT, E.MD_BOOK]
    bk = {"seq": 2, "src": "kalshi", "kind": "book", "t_recv": 2,
          "data": {"ticker": "T1", "yes": [[0.39, 5.0], [0.40, 10.0]], "no": [[0.55, 7.0], [0.54, 3.0]]}}
    (_, kind, d), = list(n(bk))
    assert d["bids"] == [[0.40, 10.0], [0.39, 5.0]]
    assert d["asks"] == [[0.45, 7.0], [0.46, 3.0]]
    assert list(n(bk)) == []  # unchanged snapshot is not re-emitted
