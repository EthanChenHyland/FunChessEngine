from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from harness.package import build


class PackageTests(unittest.TestCase):
    def test_default_package_excludes_gui_and_tools(self) -> None:
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "engine-package.zip"
            written = build(root, destination, ("weights",))
            self.assertIn("agent.py", written)
            self.assertTrue(all(not name.startswith("gui/") for name in written))
            self.assertTrue(all(not name.startswith("tools/") for name in written))
            with zipfile.ZipFile(destination) as archive:
                names = set(archive.namelist())
            self.assertIn("agent.py", names)
            self.assertFalse(any(name.startswith("gui/") for name in names))
            self.assertFalse(any(name.startswith("tools/") for name in names))

    def test_default_package_does_not_pick_up_future_root_scripts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "agent.py").write_text("def get_move(fen, time_left_ms): return 'e2e4'\n")
            (root / "debug_helper.py").write_text("raise RuntimeError('development only')\n")
            destination = root / "engine-package.zip"
            written = build(root, destination, ())
            self.assertEqual(written, ["agent.py"])
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(archive.namelist(), ["agent.py"])


if __name__ == "__main__":
    unittest.main()
