from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import chess

from integrations.uci_client import ExternalUCIEngine, calibration_score, validate_engine_path
from plugins.manifest import validate_manifest
from reporting.generator import annotated_pgn, html_report


@contextmanager
def python_uci(script: Path) -> Iterator[ExternalUCIEngine]:
    # Exercise real pipes on every OS without relying on POSIX shebang execution.
    original = subprocess.Popen

    def launch(command: list[str], **kwargs: object) -> subprocess.Popen[bytes]:
        return original([sys.executable, *command], **kwargs)  # type: ignore[call-overload,no-any-return]

    with (
        patch("integrations.uci_client.subprocess.Popen", side_effect=launch),
        ExternalUCIEngine(script) as engine,
    ):
        yield engine


class OptionalIntegrationTests(unittest.TestCase):
    def test_external_uci_client_uses_executable_without_shell(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fake-uci.py"
            script.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import sys
                    for raw in sys.stdin:
                        line = raw.strip()
                        if line == "uci": print("id name Fake\\nuciok", flush=True)
                        elif line == "isready": print("readyok", flush=True)
                        elif line.startswith("go "): print("bestmove e2e4", flush=True)
                        elif line == "quit": break
                    """
                ),
                encoding="utf-8",
            )
            script.chmod(0o755)
            self.assertEqual(validate_engine_path(script), script.resolve())
            with python_uci(script) as engine:
                result = engine.bestmove(chess.STARTING_FEN, movetime_ms=20)
            self.assertEqual(result.move, "e2e4")

    def test_external_uci_client_parses_identity_options_and_multipv(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "fake-multipv.py"
            script.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import sys
                    for raw in sys.stdin:
                        line = raw.strip()
                        if line == "uci":
                            print("id name Fake MultiPV", flush=True)
                            print("option name MultiPV type spin default 1 min 1 max 4", flush=True)
                            print(
                                "option name UCI_LimitStrength type check default false",
                                flush=True,
                            )
                            print(
                                "option name UCI_Elo type spin default 1500 min 800 max 2500",
                                flush=True,
                            )
                            print("uciok", flush=True)
                        elif line == "isready": print("readyok", flush=True)
                        elif line.startswith("go "):
                            print(
                                "info depth 8 seldepth 10 multipv 1 score cp 24 "
                                "nodes 1000 nps 50000 pv e2e4 e7e5",
                                flush=True,
                            )
                            print(
                                "info depth 8 multipv 2 score cp 14 nodes 900 "
                                "nps 45000 pv d2d4 d7d5",
                                flush=True,
                            )
                            print(
                                "info depth 8 multipv 3 score mate 5 nodes 800 "
                                "pv g1f3 d7d5",
                                flush=True,
                            )
                            print("bestmove e2e4", flush=True)
                        elif line == "quit": break
                    """
                ),
                encoding="utf-8",
            )
            script.chmod(0o755)
            with python_uci(script) as engine:
                result = engine.analyze(chess.STARTING_FEN, movetime_ms=20, multipv=3)
                self.assertEqual(engine.engine_name, "Fake MultiPV")
                self.assertEqual(engine.options["MultiPV"].maximum, 4)
                self.assertEqual(engine.options["UCI_Elo"].minimum, 800)
            self.assertEqual(result.move, "e2e4")
            self.assertEqual([line.move for line in result.lines], ["e2e4", "d2d4", "g1f3"])
            self.assertEqual(result.lines[0].score_cp, 24)
            self.assertEqual(result.lines[0].depth, 8)
            self.assertEqual(result.lines[2].mate, 5)

    def test_calibration_score_is_bounded(self) -> None:
        self.assertEqual(calibration_score([]), 1200)
        self.assertGreater(calibration_score([1, 1, 0.5]), calibration_score([0, 0, 0.5]))
        self.assertGreaterEqual(calibration_score([0] * 20), 400)
        self.assertLessEqual(calibration_score([1] * 20), 3000)

    def test_plugin_manifest_is_data_only_and_validates_chess(self) -> None:
        manifest = validate_manifest(
            {
                "id": "sample.training",
                "name": "Sample Training",
                "version": "1",
                "kind": "training",
                "items": [{"fen": chess.STARTING_FEN, "title": "Start"}],
            }
        )
        self.assertFalse(manifest.enabled)
        self.assertEqual(manifest.kind, "training")
        with self.assertRaises(ValueError):
            validate_manifest(
                {
                    "id": "bad",
                    "name": "Bad",
                    "version": "1",
                    "kind": "training",
                    "items": [{"fen": "not a fen"}],
                }
            )

    def test_reports_escape_html_and_annotate_pgn(self) -> None:
        document = html_report(
            "<Report>",
            [{"date": "today", "opening": "<script>", "result": "1-0", "accuracy": 90}],
            {"Rating": 1700},
        )
        self.assertNotIn("<script>", document)
        self.assertIn("&lt;script&gt;", document)
        pgn = '[Result "*"]\n\n1. e4 e5 *\n'
        annotated = annotated_pgn(
            pgn,
            [{"ply": 1, "classification": "Mistake", "cpl": 80, "best_san": "d4"}],
        )
        self.assertIn("FunChessEngine: Mistake, 80 CPL", annotated)


if __name__ == "__main__":
    unittest.main()
