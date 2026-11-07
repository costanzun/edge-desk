"""Append-only raw market-data log.

Every message the recorder receives becomes one JSON line with a global, monotonic
sequence number and two clocks: the venue's own timestamp when it sends one (``t_exch``,
ms) and our local receive time (``t_recv``, ns since epoch). Files rotate hourly
(``data/raw/YYYY-MM-DD/HH.jsonl``) and closed hours are gzipped, so a crash can lose at
most the line being written.
"""

from __future__ import annotations

import gzip
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import orjson


def _hour_path(root: Path, t_ns: int) -> Path:
    tm = time.gmtime(t_ns / 1e9)
    return root / time.strftime("%Y-%m-%d", tm) / f"{time.strftime('%H', tm)}.jsonl"


def last_seq(root: Path) -> int:
    """Highest sequence number already on disk (0 if empty), so restarts keep counting up.
    A torn last line (crash mid-write) is skipped."""
    files = sorted(root.glob("*/*.jsonl*"))
    for f in reversed(files):
        opener = gzip.open if f.suffix == ".gz" else open
        best = 0
        try:
            with opener(f, "rb") as fh:
                for line in fh:
                    try:
                        best = max(best, int(orjson.loads(line)["seq"]))
                    except (orjson.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
        except (OSError, EOFError):
            continue
        if best:
            return best
    return 0


class RawLog:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._seq = last_seq(root)
        self._path: Path | None = None
        self._fh = None
        self.written = 0

    @property
    def seq(self) -> int:
        return self._seq

    def append(self, src: str, kind: str, data: Any, *, t_recv: int | None = None,
               t_exch: int | None = None, rtt_ms: float | None = None) -> int:
        t_recv = t_recv or time.time_ns()
        with self._lock:
            self._seq += 1
            rec = {"seq": self._seq, "src": src, "kind": kind, "t_recv": t_recv,
                   "t_exch": t_exch, "rtt_ms": None if rtt_ms is None else round(rtt_ms, 3),
                   "data": data}
            path = _hour_path(self.root, t_recv)
            if path != self._path:
                self._rotate(path)
            assert self._fh is not None
            self._fh.write(orjson.dumps(rec) + b"\n")
            self._fh.flush()
            self.written += 1
            return self._seq

    def _rotate(self, path: Path) -> None:
        old = self._path
        if self._fh:
            self._fh.close()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(path, "ab")
        self._path = path
        if old and old.exists():
            threading.Thread(target=compress, args=(old,), daemon=True).start()

    def close(self) -> None:
        with self._lock:
            if self._fh:
                self._fh.close()
                self._fh = None


def compress(path: Path) -> None:
    gz = path.with_suffix(".jsonl.gz")
    tmp = gz.with_suffix(".gz.tmp")
    with open(path, "rb") as src, gzip.open(tmp, "wb", compresslevel=6) as dst:
        shutil.copyfileobj(src, dst)
    os.replace(tmp, gz)
    path.unlink(missing_ok=True)


def compress_stale(root: Path, current: Path | None = None) -> None:
    """Gzip any plain hour file that is not the one being written (e.g. after a crash)."""
    for f in root.glob("*/*.jsonl"):
        if current is None or f != current:
            if time.time() - f.stat().st_mtime > 120:
                compress(f)
