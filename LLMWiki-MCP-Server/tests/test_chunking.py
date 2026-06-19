"""Tests for the heading-aware chunker."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki.chunking import split_into_sections  # noqa: E402


SAMPLE = """# Style Guide

Welcome to the style guide.

## Voice

Be concise. Use active voice.

### Tone

Avoid jargon. Prefer plain English.

## Grammar

Use the Oxford comma.
"""


class ChunkingTests(unittest.TestCase):
    def test_splits_on_headings_with_breadcrumb(self) -> None:
        sections = split_into_sections(
            document_id="doc1", markdown=SAMPLE, max_section_chars=4000
        )
        # Expect 4 sections: Style Guide, Voice, Voice > Tone, Grammar.
        self.assertEqual(len(sections), 4)
        self.assertEqual(sections[0].heading, "Style Guide")
        self.assertEqual(sections[1].heading, "Voice")
        self.assertEqual(sections[2].heading, "Tone")
        self.assertEqual(sections[2].heading_path, "Style Guide > Voice > Tone")
        self.assertEqual(sections[3].heading_path, "Style Guide > Grammar")

    def test_oversize_section_is_split_at_sentence_boundary(self) -> None:
        body = " ".join(
            ["This is a sentence." for _ in range(200)]
        )
        markdown = f"# H1\n\n{body}\n"
        sections = split_into_sections(
            document_id="d", markdown=markdown, max_section_chars=400
        )
        # The H1 section should split into several chunks bounded by 400 chars.
        self.assertGreater(len(sections), 1)
        for section in sections:
            self.assertLessEqual(section.body_chars, 600)
        # All chunks share the heading metadata.
        for section in sections:
            self.assertEqual(section.heading, "H1")

    def test_flat_input_produces_single_section(self) -> None:
        sections = split_into_sections(
            document_id="d", markdown="just some text\n\nand more.", max_section_chars=4000
        )
        self.assertEqual(len(sections), 1)
        self.assertIn("just some text", sections[0].body)

    def test_pdf_anchors_attach_page_numbers(self) -> None:
        markdown = "# Page One\n\nbody A\n# Page Two\n\nbody B\n"
        # Line 0 starts page 1, line 3 starts page 2.
        anchors = {0: 1, 3: 2}
        sections = split_into_sections(
            document_id="d",
            markdown=markdown,
            line_page_anchors=anchors,
            max_section_chars=4000,
        )
        self.assertEqual(sections[0].page_anchor, 1)
        self.assertEqual(sections[1].page_anchor, 2)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
