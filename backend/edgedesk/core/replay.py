"""Replay: recorded raw log -> normalizer -> engine. The same path the live desk uses."""

from __future__ import annotations

import time
from collections.abc import Iterable, Iterator
from pathlib import Path

from edgedesk.core import events as E
from edgedesk.core.engine import Config, Engine
from edgedesk.core.events import EventLog
from edgedesk.core.reader import records
from edgedesk.venues.normalize import Normalizer

MdEvent = tuple[int, str, dict]


def md_stream(recs: Iterable[dict], timings: list[int] | None = None) -> Iterator[MdEvent]:
    norm = Normalizer()
    for rec in recs:
        if rec.get("src") == "control":
            yield rec["t_recv"], E.CONTROL, {**rec.get("data", {}), "rseq": rec.get("seq")}
            continue
        t0 = time.perf_counter_ns() if timings is not None else 0
        try:
            out = list(norm(rec))
        except (KeyError, TypeError, ValueError, IndexError, AttributeError) as e:
            # a malformed raw record: surface it to the engine's ingest guard as a feed error
            out = [(rec.get("t_recv", 0), E.MD_FEED_ERROR, {"src": rec.get("src", "?"),
                                                            "error": f"parse: {type(e).__name__}",
                                                            "rseq": rec.get("seq")})]
        if timings is not None:
            timings.append(time.perf_counter_ns() - t0)
        yield from out


def run_events(stream: Iterable[MdEvent], cfg: Config | None = None, log: EventLog | None = None,
               measure: bool = False, engine: Engine | None = None) -> Engine:
    eng = engine or Engine(cfg or Config(), log=log, measure=measure)
    for t, kind, data in stream:
        eng.process(t, kind, data)
    eng.finish()
    return eng


def run(data_dir: Path, cfg: Config | None = None, start_ns: int | None = None, end_ns: int | None = None,
        log_path: Path | None = None, measure: bool = False) -> Engine:
    timings: list[int] | None = [] if measure else None
    log = EventLog(log_path) if log_path else None
    eng = Engine(cfg or Config(), log=log, measure=measure)
    run_events(md_stream(records(data_dir, start_ns, end_ns), timings), engine=eng)
    if timings is not None:
        eng.timings["parse"] = timings
    eng.log.close()
    return eng
