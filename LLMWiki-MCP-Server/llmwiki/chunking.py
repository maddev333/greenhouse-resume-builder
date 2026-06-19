"""Heading-aware section splitter.

Given canonical markdown produced by an extractor, split the document
into ordered :class:`Section` records. Each section preserves the
hierarchical heading path ("Chapter 2 > Style > Tone") and, when the
upstream extractor provided line→page anchors, a starting page number.

Sections longer than ``config.max_section_chars`` are sub-split at
sentence boundaries to keep tool responses bounded.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from .models import Section

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\"'\[])")


@dataclass
class _RawSection:
    level: int
    heading: str
    lines: list[str]
    start_line: int


def split_into_sections(
    *,
    document_id: str,
    markdown: str,
    line_page_anchors: dict[int, int] | None = None,
    max_section_chars: int = 4000,
) -> list[Section]:
    anchors = line_page_anchors or {}
    raw_sections = _split_raw(markdown)
    sections: list[Section] = []
    ordinal = 0
    heading_stack: list[tuple[int, str]] = []
    for raw in raw_sections:
        # Maintain a stack of (level, heading) so we can build a breadcrumb.
        while heading_stack and heading_stack[-1][0] >= raw.level:
            heading_stack.pop()
        if raw.heading:
            heading_stack.append((raw.level, raw.heading))
        heading_path = " > ".join(h for _, h in heading_stack)
        body = "\n".join(raw.lines).strip()
        if not body and not raw.heading:
            continue
        page_anchor = _anchor_for_line(raw.start_line, anchors)
        for chunk in _bound_section_body(body, max_section_chars):
            sections.append(
                Section(
                    id=str(uuid.uuid4()),
                    document_id=document_id,
                    ordinal=ordinal,
                    heading_path=heading_path,
                    heading=raw.heading,
                    body=chunk,
                    body_chars=len(chunk),
                    page_anchor=page_anchor,
                )
            )
            ordinal += 1
    if not sections:
        # Fallback: index the entire document as a single section so search
        # still works on flat / un-headed inputs.
        sections.append(
            Section(
                id=str(uuid.uuid4()),
                document_id=document_id,
                ordinal=0,
                heading_path="",
                heading="",
                body=markdown.strip(),
                body_chars=len(markdown.strip()),
                page_anchor=anchors.get(0),
            )
        )
    return sections


def _split_raw(markdown: str) -> list[_RawSection]:
    raw: list[_RawSection] = []
    current = _RawSection(level=0, heading="", lines=[], start_line=0)
    for idx, line in enumerate(markdown.splitlines()):
        match = _HEADING_RE.match(line)
        if match:
            if current.heading or current.lines:
                raw.append(current)
            level = len(match.group(1))
            current = _RawSection(
                level=level,
                heading=match.group(2).strip(),
                lines=[],
                start_line=idx,
            )
            continue
        current.lines.append(line)
    if current.heading or current.lines:
        raw.append(current)
    return raw


def _anchor_for_line(
    start_line: int, anchors: dict[int, int]
) -> int | None:
    if not anchors:
        return None
    # Pick the largest anchor key <= start_line.
    best_key = -1
    for key in anchors:
        if key <= start_line and key > best_key:
            best_key = key
    if best_key < 0:
        return next(iter(anchors.values()), None)
    return anchors[best_key]


def _bound_section_body(body: str, max_chars: int) -> list[str]:
    if len(body) <= max_chars or max_chars <= 0:
        return [body]
    sentences = _SENTENCE_RE.split(body)
    chunks: list[str] = []
    buffer: list[str] = []
    buffer_len = 0
    for sentence in sentences:
        s_len = len(sentence) + 1
        if buffer and buffer_len + s_len > max_chars:
            chunks.append(" ".join(buffer).strip())
            buffer = [sentence]
            buffer_len = s_len
        else:
            buffer.append(sentence)
            buffer_len += s_len
    if buffer:
        chunks.append(" ".join(buffer).strip())
    return [c for c in chunks if c]
