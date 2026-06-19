"""Background corpus watcher.

Polls the corpus directory on a fixed interval (default 30s) and asks
the ingest service to rescan. A daemon thread is enough here; manual and
background scans are serialized so an explicit ``trigger_ingest`` call
cannot overlap a scheduled pass. We could swap in ``watchdog`` later for
inotify / ReadDirectoryChangesW, but stdlib polling is dependency-free
and works identically on Windows, macOS and Linux.
"""

from __future__ import annotations

import threading
import time
import traceback

from .ingest import IngestService


class CorpusWatcher:
    def __init__(
        self,
        ingest: IngestService,
        *,
        interval_seconds: int,
    ) -> None:
        self._ingest = ingest
        self._interval = max(1, int(interval_seconds))
        self._stop = threading.Event()
        self._scan_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._last_scan_started: float = 0.0
        self._last_scan_finished: float = 0.0
        self._last_scan_results: int = 0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="llmwiki-watcher", daemon=True
        )
        self._thread.start()

    def stop(self, *, join_timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=join_timeout)
            self._thread = None

    def trigger_once(self) -> int:
        """Run a single scan synchronously and return the result count."""
        with self._scan_lock:
            self._last_scan_started = time.time()
            try:
                results = self._ingest.scan_all()
                self._last_scan_results = len(results)
                return self._last_scan_results
            finally:
                self._last_scan_finished = time.time()

    def status(self) -> dict:
        return {
            "interval_seconds": self._interval,
            "running": bool(self._thread and self._thread.is_alive()),
            "last_scan_started": self._last_scan_started or None,
            "last_scan_finished": self._last_scan_finished or None,
            "last_scan_results": self._last_scan_results,
        }

    def _loop(self) -> None:
        # Run one scan immediately at startup so a freshly launched server
        # serves indexed content without waiting for the first interval.
        self._safe_scan()
        while not self._stop.is_set():
            if self._stop.wait(self._interval):
                return
            self._safe_scan()

    def _safe_scan(self) -> None:
        try:
            self.trigger_once()
        except Exception:  # pragma: no cover - defensive
            traceback.print_exc()
