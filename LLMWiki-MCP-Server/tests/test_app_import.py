"""Tests for import-safe ASGI entrypoint behavior."""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


class AppImportTests(unittest.TestCase):
    def test_app_import_does_not_construct_server(self) -> None:
        module = importlib.import_module("app")

        self.assertEqual(type(module.app).__name__, "_LazyASGIApp")
        self.assertIsNone(module._mcp_server)
        self.assertIsNone(module._asgi_app)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()