"""Reset the wiki index.

Deletes the sqlite database and every file under ``data/parsed/``. Run
this after big schema changes or when you want to force a full
re-ingest from scratch.

Usage::

    python scripts/reset_index.py            # asks for confirmation
    python scripts/reset_index.py --yes      # non-interactive
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki.config import load_config  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation prompt.",
    )
    args = parser.parse_args()

    config = load_config()
    db_path = config.db_path
    parsed_dir = config.parsed_dir

    print("[llmwiki] reset target:")
    print(f"  - delete {db_path}")
    print(f"  - clear  {parsed_dir}/*")
    if not args.yes:
        answer = input("Proceed? [y/N]: ").strip().lower()
        if answer != "y":
            print("aborted.")
            return 1

    if db_path.exists():
        db_path.unlink()
        print(f"  deleted {db_path}")
    # WAL sidecar files
    for sidecar in (db_path.with_suffix(".sqlite3-wal"),
                    db_path.with_suffix(".sqlite3-shm")):
        if sidecar.exists():
            sidecar.unlink()
            print(f"  deleted {sidecar}")

    if parsed_dir.exists():
        for child in parsed_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        print(f"  cleared {parsed_dir}")

    print("[llmwiki] done. Restart the server (or run `ingest_once.py`).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
