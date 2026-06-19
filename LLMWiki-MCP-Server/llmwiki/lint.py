"""Read-only health-check over the LLM-authored wiki directory.

This module never writes. It walks ``data/wiki/**/*.md``, extracts the
links each page contains (both ``[[wikilink]]`` and standard
``[text](path.md)`` markdown), and emits diagnostics so the operator
(or the agent's own write-capable tools elsewhere) can fix them.

Findings produced:

* ``orphan`` — a page is not referenced by any other wiki page and is
  not one of the canonical navigation files (``index.md``, ``log.md``,
  ``AGENTS.md``/``CLAUDE.md``, ``README.md``).
* ``broken_link`` — a link target does not resolve to an existing wiki
  page.
* ``index_gap`` — a page exists but is not mentioned anywhere in
  ``index.md``.
* ``missing_canonical`` — one of the canonical files (``index.md``,
  ``log.md``, ``AGENTS.md``) is missing entirely.
"""

from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable

from .models import WikiHealthFinding

_WIKILINK_RE = re.compile(r"\[\[([^\]\|#]+)(?:[\|#][^\]]*)?\]\]")
_MD_LINK_RE = re.compile(r"\[(?P<text>[^\]]+)\]\((?P<target>[^)\s]+)\)")
_URL_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")

CANONICAL_NAMES = {"index.md", "log.md", "AGENTS.md", "CLAUDE.md", "README.md"}


def lint_wiki(
    wiki_dir: Path,
    *,
    max_findings: int = 200,
) -> dict[str, Any]:
    if not wiki_dir.exists():
        return {
            "wiki_dir": str(wiki_dir),
            "page_count": 0,
            "finding_count": 0,
            "findings": [],
            "missing_wiki_dir": True,
        }

    pages = _collect_pages(wiki_dir)
    findings: list[WikiHealthFinding] = []
    findings.extend(_check_canonicals(wiki_dir))

    # Index every page by its case-folded relative path AND by its stem so
    # wikilinks (which carry the page name without an extension) can be
    # resolved against the real files.
    by_relpath = {_norm(str(p.relative_to(wiki_dir))): p for p in pages}
    by_stem: dict[str, list[Path]] = {}
    for p in pages:
        by_stem.setdefault(_norm(p.stem), []).append(p)

    referenced: set[str] = set()  # case-folded relpath of every linked target

    for page in pages:
        try:
            text = page.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = str(page.relative_to(wiki_dir))
        for target in _extract_link_targets(text):
            resolved = _resolve_link(
                target,
                source_page=page,
                wiki_dir=wiki_dir,
                by_relpath=by_relpath,
                by_stem=by_stem,
            )
            if resolved is None:
                findings.append(
                    WikiHealthFinding(
                        kind="broken_link",
                        severity="warn",
                        page=rel,
                        detail=f"Link target '{target}' did not resolve to a wiki page.",
                        target=target,
                    )
                )
                if len(findings) >= max_findings:
                    break
                continue
            referenced.add(_norm(str(resolved.relative_to(wiki_dir))))
        if len(findings) >= max_findings:
            break

    # Orphans: every non-canonical page that nobody else links to.
    if len(findings) < max_findings:
        for page in pages:
            rel = str(page.relative_to(wiki_dir))
            if page.name in CANONICAL_NAMES:
                continue
            if _norm(rel) in referenced:
                continue
            findings.append(
                WikiHealthFinding(
                    kind="orphan",
                    severity="info",
                    page=rel,
                    detail="Page is not referenced by any other wiki page.",
                )
            )
            if len(findings) >= max_findings:
                break

    # Index gaps: pages whose name / path never appears as link text or
    # target inside index.md. Cheap substring scan — index.md is small.
    if len(findings) < max_findings:
        index_path = wiki_dir / "index.md"
        if index_path.exists():
            try:
                index_text = index_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                index_text = ""
            index_haystack = index_text.lower()
            for page in pages:
                rel = str(page.relative_to(wiki_dir))
                if page.name in CANONICAL_NAMES:
                    continue
                needle_stem = page.stem.lower()
                needle_rel = rel.replace("\\", "/").lower()
                if needle_stem in index_haystack or needle_rel in index_haystack:
                    continue
                findings.append(
                    WikiHealthFinding(
                        kind="index_gap",
                        severity="info",
                        page=rel,
                        detail="Page is not listed in index.md.",
                    )
                )
                if len(findings) >= max_findings:
                    break

    return {
        "wiki_dir": str(wiki_dir),
        "page_count": len(pages),
        "finding_count": len(findings),
        "findings": [asdict(f) for f in findings],
    }


def _collect_pages(wiki_dir: Path) -> list[Path]:
    return sorted(p for p in wiki_dir.rglob("*.md") if p.is_file())


def _check_canonicals(wiki_dir: Path) -> Iterable[WikiHealthFinding]:
    for name in ("index.md", "log.md", "AGENTS.md"):
        path = wiki_dir / name
        if not path.exists():
            yield WikiHealthFinding(
                kind="missing_canonical",
                severity="warn" if name != "AGENTS.md" else "error",
                page=name,
                detail=(
                    f"Canonical file '{name}' is missing. Create it so the "
                    "agent can orient itself."
                ),
            )


def _extract_link_targets(text: str) -> list[str]:
    targets: list[str] = []
    for match in _MD_LINK_RE.finditer(text):
        target = match.group("target").strip()
        if not target:
            continue
        if _URL_SCHEME_RE.match(target):
            continue
        if target.startswith("#"):
            continue
        targets.append(target)
    for match in _WIKILINK_RE.finditer(text):
        name = match.group(1).strip()
        if name:
            targets.append(name)
    return targets


def _resolve_link(
    target: str,
    *,
    source_page: Path,
    wiki_dir: Path,
    by_relpath: dict[str, Path],
    by_stem: dict[str, list[Path]],
) -> Path | None:
    # Strip query/fragment.
    base = target.split("#", 1)[0].split("?", 1)[0].strip()
    if not base:
        return None

    # Wikilink style: bare name, no extension.
    candidate_stem = _norm(Path(base).stem) if base.endswith(".md") else _norm(base)
    if not base.endswith(".md") and "/" not in base and "\\" not in base:
        matches = by_stem.get(candidate_stem)
        if matches:
            return matches[0]

    # Path style: resolve relative to the source page's directory, then to
    # the wiki root as a fallback.
    candidates: list[Path] = []
    if base.endswith(".md") or "/" in base or "\\" in base:
        candidates.append((source_page.parent / base).resolve())
        candidates.append((wiki_dir / base).resolve())
    else:
        # Allow bare name to match top-level <name>.md too.
        candidates.append((wiki_dir / f"{base}.md").resolve())

    wiki_root = wiki_dir.resolve()
    for candidate in candidates:
        if not candidate.exists() or not candidate.is_file():
            continue
        try:
            candidate.relative_to(wiki_root)
        except ValueError:
            continue
        return candidate

    # Last-ditch: case-fold relpath lookup.
    rel_key = _norm(base.replace("\\", "/"))
    if rel_key in by_relpath:
        return by_relpath[rel_key]
    return None


def _norm(value: str) -> str:
    return value.replace("\\", "/").strip().lower()
