"""One-shot corpus scan + index.

Usage::

    python scripts/ingest_once.py

Run this manually after dropping new files into ``data/corpus/`` if you
don't want to wait for the background watcher (or if the watcher is
disabled with ``LLMWIKI_WATCH_INTERVAL_SECONDS=0``).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running as `python scripts/ingest_once.py` from the project root.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki.config import load_config  # noqa: E402
from llmwiki.ingest import IngestService  # noqa: E402
from llmwiki.storage import Storage  # noqa: E402


def main() -> int:
    config = load_config()
    storage = Storage(config.db_path)
    ingest = IngestService(config, storage)
    print(f"[llmwiki] scanning corpus: {config.corpus_dir}")
    results = ingest.scan_corpus()
    by_status: dict[str, int] = {}
    for result in results:
        by_status[result.status] = by_status.get(result.status, 0) + 1
        if result.status in {"error", "skipped"}:
            print(f"  [{result.status}] {result.source_path} — {result.message}")
        else:
            print(f"  [{result.status}] {result.source_path}")
    print(f"[llmwiki] done: {len(results)} files, summary={by_status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
