"""The live paper desk: the engine folding the raw log as the recorder writes it.

Live trading here is literally a replay that keeps going: the desk reads closed hours
(gzipped) and then tails the open hour file, with a 2-second reorder buffer so records
reach the engine in the same (receive time, sequence) order a later replay will use.
That is what makes every live decision reproducible bit-for-bit afterwards.

Sources: ``live`` (the recorder's log, default), ``synthetic`` (the seeded synthetic market,
paced in accelerated time, for demos), ``replay`` (a recorded window, paced).
"""

from __future__ import annotations

import gzip
import logging
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import orjson

from edgedesk.core import events as E
from edgedesk.core.engine import Config, Engine
from edgedesk.core.reader import _read_file, hour_files
from edgedesk.venues.normalize import Normalizer

log = logging.getLogger("edgedesk.desk")
NS = 1_000_000_000
REORDER_NS = 2 * NS


class Desk:
    def __init__(self, data: Path, cfg: Config, source: str = "live", lookback_h: float = 24.0,
                 speed: float = 30.0) -> None:
        self.data = data
        self.cfg = cfg
        self.source = source
        self.lookback_h = lookback_h
        self.speed = speed
        self.lock = threading.RLock()
        self.engine = Engine(cfg, measure=True)
        self.norm = Normalizer()
        self.net_recs: deque[dict] = deque(maxlen=300_000)   # light copies for latency stats
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._offsets: dict[Path, int] = {}
        self._ctrl_offset = 0
        self._buf: list[dict] = []
        self._last_key: tuple[int, int] = (0, -10**12)
        self.started = time.time()
        # demo sources get their own control log so a demo kill never leaks into real replays
        self.ctrl_path = data / ("control.jsonl" if source == "live" else f"control-{source}.jsonl")
        self.caught_up = False
        self.records = 0

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="desk", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _feed(self, rec: dict) -> None:
        key = (rec.get("t_recv", 0), rec.get("seq", 0))
        if key <= self._last_key and rec.get("src") != "control":
            return
        self._last_key = max(self._last_key, key)
        self.records += 1
        if rec.get("rtt_ms") is not None or rec.get("t_exch"):
            d = rec.get("data") or {}
            self.net_recs.append({"src": rec.get("src"), "kind": rec.get("kind"), "rtt_ms": rec.get("rtt_ms"),
                                  "t_exch": rec.get("t_exch"), "t_recv": rec.get("t_recv"),
                                  "data": {"ws": d.get("ws")} if isinstance(d, dict) else {}})
        with self.lock:
            if rec.get("src") == "control":
                self.engine.process(rec["t_recv"], E.CONTROL, {**rec.get("data", {}), "rseq": rec.get("seq")})
                return
            t0 = time.perf_counter_ns()
            try:
                out = list(self.norm(rec))
            except (KeyError, TypeError, ValueError, IndexError, AttributeError) as e:
                out = [(rec.get("t_recv", 0), E.MD_FEED_ERROR, {"src": rec.get("src", "?"),
                                                                "error": f"parse: {type(e).__name__}",
                                                                "rseq": rec.get("seq")})]
            self.engine.timings["parse"].append(time.perf_counter_ns() - t0)
            if len(self.engine.timings["parse"]) > 200_000:
                for k in self.engine.timings:
                    del self.engine.timings[k][:100_000]
            for t, kind, d in out:
                self.engine.process(t, kind, d)

    def _run(self) -> None:
        try:
            if self.source == "synthetic":
                self._run_synthetic()
            elif self.source == "replay":
                self._run_paced(self._history())
            else:
                self._run_live()
        except Exception:  # noqa: BLE001
            log.exception("desk thread crashed")

    # ------------------------------------------------------------------ sources
    def _history(self) -> list[dict]:
        start = time.time_ns() - int(self.lookback_h * 3600 * NS)
        recs = []
        for f in hour_files(self.data / "raw", start, None):
            if f.suffix == ".gz":
                recs.extend(r for r in _read_file(f) if r.get("t_recv", 0) >= start)
        return recs

    def _run_live(self) -> None:
        start = time.time_ns() - int(self.lookback_h * 3600 * NS)
        hist = self._history()
        for r in self._controls(start):
            hist.append(r)
        hist.sort(key=lambda r: (r.get("t_recv", 0), r.get("seq", 0)))
        for r in hist:
            if self._stop.is_set():
                return
            self._feed(r)
        while not self._stop.is_set():
            self._tail(start)
            self.caught_up = True
            self._stop.wait(0.5)

    def _controls(self, start: int) -> list[dict]:
        p = self.ctrl_path
        if not p.exists():
            return []
        raw = p.read_bytes()
        end = raw.rfind(b"\n") + 1
        self._ctrl_offset = end
        out = []
        for line in raw[:end].splitlines():
            try:
                r = orjson.loads(line)
            except orjson.JSONDecodeError:
                continue
            if r.get("t_recv", 0) >= start:
                out.append(r)
        return out

    def _tail(self, start: int) -> None:
        raw_dir = self.data / "raw"
        plain = sorted(raw_dir.glob("*/*.jsonl"))
        # files we were tailing that got compressed meanwhile: finish them from the .gz
        for f in list(self._offsets):
            if not f.exists():
                gz = f.with_suffix(".jsonl.gz")
                if gz.exists():
                    with gzip.open(gz, "rb") as fh:
                        fh.seek(self._offsets[f])
                        self._take(fh.read(), start)
                del self._offsets[f]
        for f in plain:
            off = self._offsets.get(f, 0)
            try:
                with open(f, "rb") as fh:
                    fh.seek(off)
                    chunk = fh.read()
            except FileNotFoundError:
                continue
            end = chunk.rfind(b"\n") + 1
            self._offsets[f] = off + end
            self._take(chunk[:end], start)
        p = self.ctrl_path
        if p.exists():
            with open(p, "rb") as fh:
                fh.seek(self._ctrl_offset)
                chunk = fh.read()
            end = chunk.rfind(b"\n") + 1
            self._ctrl_offset += end
            self._take(chunk[:end], start)
        cutoff = time.time_ns() - REORDER_NS
        self._buf.sort(key=lambda r: (r.get("t_recv", 0), r.get("seq", 0)))
        ready = [r for r in self._buf if r.get("t_recv", 0) <= cutoff]
        self._buf = [r for r in self._buf if r.get("t_recv", 0) > cutoff]
        for r in ready:
            self._feed(r)

    def _take(self, chunk: bytes, start: int) -> None:
        for line in chunk.splitlines():
            try:
                r = orjson.loads(line)
            except orjson.JSONDecodeError:
                continue
            if r.get("t_recv", 0) >= start:
                self._buf.append(r)

    def _run_paced(self, recs: list[dict]) -> None:
        if not recs:
            return
        recs.sort(key=lambda r: (r.get("t_recv", 0), r.get("seq", 0)))
        t_data0, t_wall0 = recs[0]["t_recv"], time.time_ns()
        i = 0
        while i < len(recs) and not self._stop.is_set():
            target = t_data0 + int((time.time_ns() - t_wall0) * self.speed)
            ctrl = self._controls_new()
            for r in ctrl:  # operator actions during a paced demo are stamped in data time
                r["t_recv"] = max(r["t_recv"], self.engine.t)
                self._feed(r)
            while i < len(recs) and recs[i]["t_recv"] <= target:
                self._feed(recs[i])
                i += 1
            self.caught_up = True
            self._stop.wait(0.2)

    def _controls_new(self) -> list[dict]:
        p = self.ctrl_path
        if not p.exists():
            return []
        with open(p, "rb") as fh:
            fh.seek(self._ctrl_offset)
            chunk = fh.read()
        end = chunk.rfind(b"\n") + 1
        self._ctrl_offset += end
        out = []
        for line in chunk[:end].splitlines():
            try:
                out.append(orjson.loads(line))
            except orjson.JSONDecodeError:
                pass
        return out

    def _run_synthetic(self) -> None:
        from edgedesk.sim.synthetic import Scenario, generate

        p = self.ctrl_path
        self._ctrl_offset = p.stat().st_size if p.exists() else 0
        recs = generate(Scenario(hours=6.0, seed=21))
        # first 40 minutes instantly (warm state), the rest paced
        cut = recs[0]["t_recv"] + 40 * 60 * NS
        for r in recs:
            if r["t_recv"] > cut:
                break
            self._feed(r)
        self._run_paced([r for r in recs if r["t_recv"] > cut])

    # ------------------------------------------------------------------ control
    def control(self, action: str, reason: str = "") -> dict[str, Any]:
        """Append an operator action to the control log. The desk (and any later replay) picks
        it up in time order, so a kill switch press is part of the reproducible record."""
        with self.lock:
            # stamped at the engine's current event time: the action lands between the same two
            # records live and in any later replay of the log
            t = max(self.engine.t, 0) + 1
            rec = {"seq": -int(time.time_ns() // 1000), "src": "control", "kind": action, "t_recv": t,
                   "data": {"action": action,
                            "reason": reason or ("kill switch (UI)" if action == "kill" else "resumed (UI)")}}
            p = self.ctrl_path
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "ab") as fh:
                fh.write(orjson.dumps(rec) + b"\n")
            self._ctrl_offset = p.stat().st_size  # do not re-read our own write
            self.engine.process(t, E.CONTROL, {**rec["data"], "rseq": rec["seq"]})
        return {"t": t // 1_000_000, **rec["data"], "halted": self.engine.halted}

    def status(self) -> dict[str, Any]:
        return {"source": self.source, "caught_up": self.caught_up, "records": self.records,
                "uptime_s": round(time.time() - self.started), "engine_t": self.engine.t // 1_000_000,
                "lag_s": round((time.time_ns() - self.engine.t) / NS, 1) if self.engine.t else None}
