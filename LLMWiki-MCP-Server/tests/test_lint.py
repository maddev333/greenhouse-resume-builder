"""Tests for the read-only wiki health-checker."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmwiki.lint import lint_wiki  # noqa: E402


def _kinds(findings: list[dict]) -> list[str]:
    return [f["kind"] for f in findings]


def _findings_for(findings: list[dict], page: str) -> list[dict]:
    return [f for f in findings if f["page"].replace("\\", "/") == page]


class LintWikiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.wiki = Path(self._tmp.name) / "wiki"
        self.wiki.mkdir()

    def _write(self, name: str, content: str) -> None:
        path = self.wiki / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_missing_wiki_dir(self) -> None:
        missing = Path(self._tmp.name) / "does-not-exist"
        result = lint_wiki(missing)
        self.assertTrue(result.get("missing_wiki_dir"))
        self.assertEqual(result["page_count"], 0)
        self.assertEqual(result["finding_count"], 0)

    def test_missing_canonicals_reported(self) -> None:
        self._write("alpha.md", "# Alpha\n\nJust some text.\n")
        result = lint_wiki(self.wiki)
        kinds = _kinds(result["findings"])
        # AGENTS.md missing -> error, index.md / log.md missing -> warn.
        canonical_findings = [
            f for f in result["findings"] if f["kind"] == "missing_canonical"
        ]
        self.assertEqual(len(canonical_findings), 3)
        pages = {f["page"] for f in canonical_findings}
        self.assertEqual(pages, {"AGENTS.md", "index.md", "log.md"})
        severities = {f["page"]: f["severity"] for f in canonical_findings}
        self.assertEqual(severities["AGENTS.md"], "error")
        self.assertEqual(severities["index.md"], "warn")
        self.assertEqual(severities["log.md"], "warn")

    def test_orphan_broken_link_and_index_gap(self) -> None:
        self._write(
            "AGENTS.md",
            "# Agents schema\n\nPage conventions go here.\n",
        )
        self._write(
            "index.md",
            "# Index\n\n- [Alpha](alpha.md)\n- [Bravo](bravo.md)\n",
        )
        self._write("log.md", "# Log\n\n## [2025-01-01] ingest | seed\n")
        self._write(
            "alpha.md",
            "# Alpha\n\nSee [[bravo]] and the missing [[ghost]] page.\n",
        )
        self._write("bravo.md", "# Bravo\n\nReferenced from alpha.\n")
        self._write("orphan.md", "# Orphan\n\nNo one links here.\n")

        result = lint_wiki(self.wiki)
        findings = result["findings"]
        kinds = _kinds(findings)

        # No canonical files are missing.
        self.assertNotIn("missing_canonical", kinds)

        # Broken link to 'ghost' should surface from alpha.md.
        broken = [f for f in findings if f["kind"] == "broken_link"]
        self.assertTrue(
            any(b["target"] == "ghost" for b in broken),
            f"expected ghost broken_link, got {broken}",
        )

        # orphan.md is orphaned. alpha.md and bravo.md are not (referenced from
        # index.md / from each other).
        orphans = {
            f["page"].replace("\\", "/")
            for f in findings
            if f["kind"] == "orphan"
        }
        self.assertIn("orphan.md", orphans)
        self.assertNotIn("alpha.md", orphans)
        self.assertNotIn("bravo.md", orphans)

        # orphan.md is also missing from index.md.
        index_gaps = {
            f["page"].replace("\\", "/")
            for f in findings
            if f["kind"] == "index_gap"
        }
        self.assertIn("orphan.md", index_gaps)
        self.assertNotIn("alpha.md", index_gaps)
        self.assertNotIn("bravo.md", index_gaps)

        # Sanity: page_count counts only .md files.
        self.assertEqual(result["page_count"], 6)

    def test_external_links_are_not_flagged(self) -> None:
        self._write("AGENTS.md", "# Agents schema\n")
        self._write("index.md", "# Index\n\n- [Alpha](alpha.md)\n")
        self._write("log.md", "# Log\n")
        self._write(
            "alpha.md",
            "# Alpha\n\nExternal: [Google](https://google.com)"
            "\nAnchor: [self](#section)\n",
        )
        result = lint_wiki(self.wiki)
        broken = [f for f in result["findings"] if f["kind"] == "broken_link"]
        self.assertEqual(broken, [])

    def test_max_findings_caps_results(self) -> None:
        self._write("AGENTS.md", "# schema\n")
        self._write("index.md", "# Index\n")
        self._write("log.md", "# Log\n")
        for i in range(20):
            self._write(f"orphan-{i}.md", f"# Orphan {i}\n")
        result = lint_wiki(self.wiki, max_findings=5)
        self.assertLessEqual(result["finding_count"], 5)
        self.assertEqual(len(result["findings"]), result["finding_count"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
