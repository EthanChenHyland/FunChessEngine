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


if __name__ == "__main__":
    unittest.main()
