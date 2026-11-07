"""Read the recorder's raw log back as an ordered stream of records.

Records are ordered by (local receive time, recorder sequence). Operator control records
(kill switch, resume) live in ``data/control.jsonl`` and are merged in by time so a replay
reproduces what the operator did live.
"""

from __future__ import annotations

import gzip
import heapq
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson


def hour_files(raw: Path, start_ns: int | None = None, end_ns: int | None = None) -> list[Path]:
    out = []
    for f in sorted(raw.glob("*/*.jsonl*")):
        if f.name.endswith(".tmp"):
            continue
        day = f.parent.name
        hour = f.name.split(".")[0]
        try:
            t0 = int(datetime.strptime(f"{day} {hour}", "%Y-%m-%d %H").replace(tzinfo=UTC).timestamp())
        except ValueError:
            continue
        t0_ns, t1_ns = t0 * 1_000_000_000, (t0 + 3600) * 1_000_000_000
        if start_ns is not None and t1_ns <= start_ns:
            continue
        if end_ns is not None and t0_ns >= end_ns:
            continue
        out.append(f)
    # If both a plain and a gz version exist (mid-compression), prefer the plain one.
    seen: dict[str, Path] = {}
    for f in out:
        key = str(f).removesuffix(".gz")
        if key not in seen or not str(f).endswith(".gz"):
            seen[key] = f
    return sorted(seen.values())


def _read_file(f: Path) -> list[dict[str, Any]]:
    opener = gzip.open if f.suffix == ".gz" else open
    recs = []
    with opener(f, "rb") as fh:
        for line in fh:
            try:
                recs.append(orjson.loads(line))
            except orjson.JSONDecodeError:
                continue  # torn last line of a crashed writer
    recs.sort(key=lambda r: (r.get("t_recv", 0), r.get("seq", 0)))
    return recs


def records(data: Path, start_ns: int | None = None, end_ns: int | None = None) -> Iterator[dict[str, Any]]:
    def raw_iter() -> Iterator[dict[str, Any]]:
        # an hour can span several files (a restart mid-hour leaves "HH.<ts>.jsonl.gz" next to
        # "HH.jsonl.gz"): merge each hour's files by receive time, not by file name
        groups: dict[tuple[str, str], list[Path]] = {}
        for f in hour_files(data / "raw", start_ns, end_ns):
            groups.setdefault((f.parent.name, f.name[:2]), []).append(f)
        for key in sorted(groups):
            recs = [r for f in groups[key] for r in _read_file(f)]
            recs.sort(key=lambda r: (r.get("t_recv", 0), r.get("seq", 0)))
            for r in recs:
                t = r.get("t_recv", 0)
                if (start_ns is None or t >= start_ns) and (end_ns is None or t < end_ns):
                    yield r

    ctrl = data / "control.jsonl"
    controls = []
    if ctrl.exists():
        for line in ctrl.read_bytes().splitlines():
            try:
                r = orjson.loads(line)
            except orjson.JSONDecodeError:
                continue
            t = r.get("t_recv", 0)
            if (start_ns is None or t >= start_ns) and (end_ns is None or t < end_ns):
                controls.append(r)
    yield from heapq.merge(raw_iter(), sorted(controls, key=lambda r: r["t_recv"]),
                           key=lambda r: (r.get("t_recv", 0), r.get("seq", 0)))


def data_span(data: Path) -> tuple[int, int] | None:
    files = hour_files(data / "raw")
    if not files:
        return None
    first = _read_file(files[0])
    last = _read_file(files[-1])
    if not first or not last:
        return None
    return first[0]["t_recv"], last[-1]["t_recv"]


def iter_list(recs: Iterable[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    yield from recs
