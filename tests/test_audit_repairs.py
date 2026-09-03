"""Behavioral regressions for the September application audit."""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import chess

import agent
from gui import workspace
from gui.imports import import_reference_file
from gui.jobs import JobCancelled, JobRegistry, check_cancelled, run_process
from gui.server import JOBS as SERVER_JOBS
from gui.server import GameSession, _submit_job, _validate_workspace_metadata
from harness.process_io import (
    LineReader,
    PipeError,
    register_process,
    terminate_active_processes,
    terminate_tree,
)
from integrations.tournament import _InternalEngine, run_tournament
from librarydb.store import LibraryDatabase, structure_tags
from openingbook.store import OpeningBook


class AuditRepairsTests(unittest.TestCase):
    def tearDown(self) -> None:
        agent.reset_game_state()

    def test_session_normalizes_chess960_castling(self) -> None:
        session = GameSession()
        session.reset(chess.STARTING_FEN, 60000, 0, chess960=True)
        for move in ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"]:
            session.play_move(move)
        with patch.object(agent, "get_move", return_value="e1g1"):
            session.engine_move()
        self.assertEqual(session.board.king(chess.WHITE), chess.G1)
        self.assertEqual(session.board.piece_at(chess.F1), chess.Piece(chess.ROOK, chess.WHITE))

    def test_selfplay_observes_each_position_once_and_history_is_bounded(self) -> None:
        agent.reset_game_state()
        board = chess.Board()
        board.push_uci(agent.get_move(board.fen(), 60000))
        key = agent._repetition_key(board)
        agent.get_move(board.fen(), 60000)
        self.assertEqual(agent.SEEN_POSITIONS[key], 1)
        agent.reset_game_state()
        for index in range(2000):
            agent._observe_position(index)
        self.assertLessEqual(len(agent.SEEN_POSITIONS), 1024)
        self.assertLessEqual(len(agent.OBSERVED_POSITIONS), 1024)
        board = chess.Board()
        for move in ["g1f3", "g8f6", "f3g1", "f6g8"]:
            board.push_uci(move)
        agent.set_game_history(board)
        self.assertEqual(agent.SEEN_POSITIONS[agent._repetition_key(board)], 1)

    def test_internal_tournament_uses_explicit_move_budget(self) -> None:
        with patch.object(agent, "get_move", return_value="e2e4") as move:
            _InternalEngine().move(chess.Board(), 80)
        self.assertEqual(move.call_args.kwargs["move_budget_ms"], 80)

    def test_full_round_robin_and_paired_openings(self) -> None:
        openings = [chess.STARTING_FEN, "7k/8/8/8/8/8/8/K7 w - - 0 1"]

        def play(*args: object, **kwargs: object) -> dict[str, object]:
            return {"result": "1/2-1/2", "pgn": "*", "fen": kwargs["initial_fen"]}

        with (
            patch("integrations.tournament.play_game", side_effect=play),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            result = run_tournament(
                {
                    "participants": [{"name": str(i), "kind": "funchess"} for i in range(12)],
                    "openings": openings,
                    "color_reversal": True,
                }
            )
        self.assertEqual(len(result["games"]), 132)
        self.assertTrue(all(row["games"] == 22 for row in result["standings"]))
        self.assertTrue(all(row["performance_elo"] is None for row in result["standings"]))
        for index in range(0, 132, 2):
            self.assertEqual(result["games"][index]["fen"], result["games"][index + 1]["fen"])

    def test_passed_pawn_sixth_rank_is_color_relative(self) -> None:
        for piece, square, expected in [
            ("P", chess.A3, False),
            ("P", chess.A6, True),
            ("p", chess.A3, True),
            ("p", chess.A6, False),
        ]:
            board = chess.Board("7k/8/8/8/8/8/8/7K w - - 0 1")
            board.set_piece_at(square, chess.Piece.from_symbol(piece))
            self.assertEqual("passed pawn on sixth rank" in structure_tags(board), expected)

    def test_pipe_timeout_and_oversized_output_are_bounded(self) -> None:
        for code, limit, message in [
            ("import time; time.sleep(5)", 65536, "timed out"),
            ('print("x"*5000, flush=True)', 100, "too long"),
        ]:
            process = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE)
            assert process.stdout
            reader = LineReader(process.stdout, line_limit=limit)
            try:
                with self.assertRaisesRegex(PipeError, message):
                    reader.readline(time.monotonic() + 0.3)
            finally:
                terminate_tree(process)
                reader.thread.join(1)
                process.stdout.close()

    def test_worker_timeout_and_job_cancellation(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            run_process(
                [sys.executable, "-c", "import sys,time; sys.stdin.read(); time.sleep(5)"],
                {},
                0.1,
                os.getcwd(),
            )
        registry = JobRegistry(limit=1)
        started = threading.Event()

        def work() -> dict[str, object]:
            started.set()
            while True:
                check_cancelled()
                time.sleep(0.005)

        job = registry.submit("test", work)
        self.assertTrue(started.wait(1))
        with self.assertRaisesRegex(RuntimeError, "limit"):
            registry.submit("overflow", work)
        registry.cancel(job["id"])
        deadline = time.monotonic() + 2
        while registry.get(job["id"])["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(registry.get(job["id"])["status"], "cancelled")

    def test_backend_shutdown_cleanup_terminates_registered_worker_tree(self) -> None:
        with tempfile.NamedTemporaryFile(delete=False) as marker_file:
            marker_name = marker_file.name
        os.unlink(marker_name)
        code = (
            "import subprocess,sys,time; "
            f"child=subprocess.Popen([sys.executable,'-c',\"import time; time.sleep(30)\"]); "
            f"open({marker_name!r},'w').write(str(child.pid)); time.sleep(30)"
        )
        process = subprocess.Popen(
            [sys.executable, "-c", code],
            start_new_session=os.name != "nt",
        )
        register_process(process, group=os.name != "nt")
        try:
            deadline = time.monotonic() + 2
            while not os.path.exists(marker_name) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(os.path.exists(marker_name))
            child_pid = int(Path(marker_name).read_text())
            terminate_active_processes()
            process.wait(timeout=2)
            if os.name != "nt":
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
        finally:
            terminate_tree(process, group=os.name != "nt")
            Path(marker_name).unlink(missing_ok=True)

    def test_workspace_metadata_rejects_invalid_positions_and_mismatched_edges(self) -> None:
        valid = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"
        child = "4k3/8/8/8/8/4P3/8/4K3 b - - 0 1"
        metadata = {
            "studies": {
                "one": {
                    "root": "r",
                    "nodes": {
                        "r": {"id": "r", "children": ["c"], "snapshot": {"fen": valid}},
                        "c": {"id": "c", "children": [], "snapshot": {"fen": child}},
                    },
                    "edges": {"r>c": {"move_uci": "e2e3"}},
                }
            }
        }
        self.assertEqual(_validate_workspace_metadata(metadata), {"valid": True})
        metadata["studies"]["one"]["edges"]["r>c"]["move_uci"] = "e2e4"
        with self.assertRaisesRegex(ValueError, "does not reach"):
            _validate_workspace_metadata(metadata)
        metadata["studies"]["one"]["edges"]["r>c"]["move_uci"] = "e2e3"
        metadata["studies"]["one"]["nodes"]["c"]["snapshot"]["fen"] = "8/8/8/8/8/8/8/8 b - - 0 1"
        with self.assertRaisesRegex(ValueError, "invalid chess position"):
            _validate_workspace_metadata(metadata)

    def test_workspace_metadata_rejects_study_cycles_and_orphan_edges(self) -> None:
        fen = "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
        cyclic = {
            "studies": {
                "one": {
                    "root": "r",
                    "nodes": {
                        "r": {"id": "r", "children": ["c"], "snapshot": {"fen": fen}},
                        "c": {"id": "c", "children": ["r"], "snapshot": {"fen": fen}},
                    },
                    "edges": {},
                }
            }
        }
        with self.assertRaisesRegex(ValueError, "cycle"):
            _validate_workspace_metadata(cyclic)

        clean = {
            "studies": {
                "one": {
                    "root": "r",
                    "nodes": {"r": {"id": "r", "children": [], "snapshot": {"fen": fen}}},
                    "edges": {"r>missing": {"move_uci": "e1e2"}},
                }
            }
        }
        with self.assertRaisesRegex(ValueError, "orphan edge"):
            _validate_workspace_metadata(clean)

    def test_workspace_metadata_accepts_legacy_chess960_snapshot_without_variant(self) -> None:
        fen = chess.Board.from_chess960_pos(0).fen()
        metadata = {
            "studies": {
                "960": {
                    "root": "r",
                    "nodes": {"r": {"id": "r", "children": [], "snapshot": {"fen": fen}}},
                    "edges": {},
                }
            }
        }
        self.assertEqual(_validate_workspace_metadata(metadata), {"valid": True})

    def test_workspace_accepts_legal_en_passant_normalization_and_recovers_legacy_edges(
        self,
    ) -> None:
        board = chess.Board()
        nodes = {"r": {"id": "r", "children": ["c"], "snapshot": {"fen": board.fen()}}}
        board.push_uci("e2e4")
        nodes["c"] = {"id": "c", "children": [], "snapshot": {"fen": board.fen()}}
        study = {"root": "r", "nodes": nodes, "edges": {"r>c": {"move_uci": "e2e4"}}}
        metadata = {"studies": {"one": study}}
        self.assertEqual(_validate_workspace_metadata(metadata), {"valid": True})
        study["edges"] = {}
        _validate_workspace_metadata(metadata)
        self.assertEqual(study["edges"]["r>c"]["move_uci"], "e2e4")
        nodes["c"]["snapshot"]["fen"] = chess.STARTING_FEN
        study["edges"] = {}
        with self.assertRaisesRegex(ValueError, "Cannot recover"):
            _validate_workspace_metadata(metadata)

    def test_legacy_transposition_edges_recover_both_move_orders(self) -> None:
        nodes = {}
        for prefix, moves in [("a", ["g1f3", "g8f6", "b1c3"]), ("b", ["b1c3", "g8f6", "g1f3"])]:
            board = chess.Board()
            parent = "r"
            nodes.setdefault("r", {"id": "r", "children": [], "snapshot": {"fen": board.fen()}})
            for index, move in enumerate(moves):
                board.push_uci(move)
                child = "shared" if index == 2 else f"{prefix}{index}"
                nodes[parent]["children"].append(child)
                nodes.setdefault(
                    child, {"id": child, "children": [], "snapshot": {"fen": board.fen()}}
                )
                parent = child
        study = {"root": "r", "nodes": nodes, "edges": {}}
        _validate_workspace_metadata({"studies": {"test": study}})
        self.assertEqual(study["edges"]["a1>shared"]["move_uci"], "b1c3")
        self.assertEqual(study["edges"]["b1>shared"]["move_uci"], "g1f3")

    def test_restored_plugins_require_legal_training_and_opening_moves(self) -> None:
        plugin = {
            "id": "test",
            "name": "Test",
            "version": "1",
            "kind": "training",
            "items": [{"fen": chess.STARTING_FEN, "best_uci": "e2e5"}],
        }
        with self.assertRaisesRegex(ValueError, "illegal"):
            _validate_workspace_metadata({"plugins": [plugin]})
        plugin["items"][0]["best_uci"] = "0000"
        with self.assertRaisesRegex(ValueError, "illegal"):
            _validate_workspace_metadata({"plugins": [plugin]})
        plugin["items"][0]["best_uci"] = "e2e4"
        self.assertEqual(_validate_workspace_metadata({"plugins": [plugin]}), {"valid": True})
        plugin.update(kind="openings", items=[{"name": "Bad", "moves": ["e2e5"]}])
        with self.assertRaisesRegex(ValueError, "illegal"):
            _validate_workspace_metadata({"plugins": [plugin]})

    def test_worker_deadline_covers_a_child_that_never_reads_input(self) -> None:
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            run_process(
                [sys.executable, "-c", "import time; time.sleep(4)"],
                {"data": "x" * (1024 * 1024)},
                0.15,
                os.getcwd(),
            )
        self.assertLess(time.monotonic() - started, 2)

    def test_comparison_uses_the_same_supported_budget_on_both_sides(self) -> None:
        from unittest.mock import MagicMock

        session = GameSession()
        fake = MagicMock()
        fake.__enter__.return_value = fake
        fake.analyze.return_value.move = "e2e4"
        fake.analyze.return_value.engine_name = "Fake"
        fake.analyze.return_value.lines = ()
        fake.analyze.return_value.info = ()
        fake.options = {}
        with (
            patch.object(session, "multipv_fen", return_value={"lines": []}) as ours,
            patch("gui.server.ExternalUCIEngine", return_value=fake),
        ):
            for requested, expected in [(50, 100), (5000, 2000)]:
                result = session.compare_external_uci("fake", chess.STARTING_FEN, requested)
                self.assertEqual(result["budget_ms"], expected)
                self.assertEqual(ours.call_args.args[2], expected)
                self.assertEqual(fake.analyze.call_args.args[1], expected)


class WorkspaceRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"FUNCHESS_DATA_DIR": str(self.root / "profile")})
        self.env.start()
        self.tokens: list[str] = []

    def tearDown(self) -> None:
        for token in self.tokens:
            workspace.upload({"action": "cancel", "token": token})
        self.env.stop()
        self.temp.cleanup()

    def upload(self, data: bytes) -> str:
        token = workspace.upload({"size": len(data), "name": "test"})["token"]
        self.tokens.append(token)
        for offset in range(0, len(data), 1024 * 1024):
            workspace.upload(
                {
                    "action": "chunk",
                    "token": token,
                    "offset": offset,
                    "data": base64.b64encode(data[offset : offset + 1024 * 1024]).decode(),
                }
            )
        workspace.upload({"action": "finish", "token": token})
        return str(token)

    def test_bundle_restores_library_book_and_metadata_to_fresh_profile(self) -> None:
        database = LibraryDatabase()
        database.import_pgn_text('[Event "Backup"]\n\n1. e4 e5 *')
        OpeningBook().add_move(chess.STARTING_FEN, "d2d4", weight=9)
        metadata = {
            "format": "FunChessEngine.WorkspaceBackup",
            "version": 2,
            "calibration_history": [{"estimated_elo": 1500}],
        }
        bundle = workspace.create_bundle(metadata, True)
        self.tokens.append(bundle["token"])
        fresh = self.root / "fresh"
        with patch.dict(os.environ, {"FUNCHESS_DATA_DIR": str(fresh)}):
            restored = workspace.restore_bundle(bundle["token"])
            self.assertEqual(restored["metadata"], metadata)
            self.assertEqual(LibraryDatabase().stats()["games"], 1)
            with sqlite3.connect(fresh / "opening-book.sqlite3") as connection:
                self.assertEqual(
                    connection.execute("SELECT move_uci,weight FROM book_moves").fetchone(),
                    ("d2d4", 9),
                )

    def test_bad_bundle_is_rejected_without_changing_live_database(self) -> None:
        LibraryDatabase().import_pgn_text('[Event "Keep"]\n\n1. e4 *')
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr("workspace.json", "{}")
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "format": "FunChessEngine.WorkspaceBundle",
                        "version": 1,
                        "included": ["workspace.json"],
                    }
                ),
            )
            archive.writestr("../library.sqlite3", "bad")
        token = self.upload(data.getvalue())
        with self.assertRaises(ValueError):
            workspace.restore_bundle(token)
        self.assertEqual(LibraryDatabase().stats()["games"], 1)

    def test_active_transfer_cannot_be_deleted(self) -> None:
        token = self.upload(b"test")
        with workspace.leased_file(token), self.assertRaisesRegex(ValueError, "Cancel the import"):
            workspace.upload({"action": "cancel", "token": token})

    def test_large_import_checkpoint_resumes_after_cancellation(self) -> None:
        path = self.root / "large.pgn"
        path.write_text(
            "\n\n".join(
                f'[Event "Game {i}"]\n\n1. e4 {{' + ("comment " * 3000) + "} e5 *"
                for i in range(110)
            )
        )
        self.assertGreater(path.stat().st_size, 2 * 1024 * 1024)
        database = LibraryDatabase()
        with (
            patch("gui.imports.progress", side_effect=JobCancelled("cancel")),
            self.assertRaises(JobCancelled),
        ):
            import_reference_file(database, path, "test")
        self.assertEqual(database.stats()["games"], 100)
        result = import_reference_file(database, path, "test")
        self.assertTrue(result["resumed"])
        self.assertEqual(result["imported"], 110)
        self.assertEqual(database.stats()["games"], 110)
        self.assertEqual(import_reference_file(database, path, "test")["imported"], 110)

    def test_reference_import_job_releases_transfer_without_browser_cleanup(self) -> None:
        token = self.upload(b'[Event "Import"]\n\n1. e4 e5 *')
        database = LibraryDatabase(self.root / "job-library.sqlite3")
        with patch("gui.server._library_database", return_value=database):
            job = _submit_job("reference-import", {"token": token})
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                current = SERVER_JOBS.get(job["id"])
                if current["status"] != "running":
                    break
                time.sleep(0.01)
            self.assertEqual(SERVER_JOBS.get(job["id"])["status"], "completed")
        self.tokens.remove(token)
        with self.assertRaisesRegex(ValueError, "expired or is unknown"):
            workspace.upload({"action": "cancel", "token": token})
