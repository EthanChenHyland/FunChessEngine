"""Database workspace data integrity and query semantics."""

from __future__ import annotations

import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import chess
import chess.pgn

from librarydb.store import LibraryDatabase
from librarydb.workbench import LibraryWorkbench
from tests.test_librarydb import SAMPLE_PGN


class LibraryWorkbenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = LibraryDatabase(Path(self.temp.name) / "library.sqlite3")
        self.database.import_pgn_text(SAMPLE_PGN)
        self.workbench = LibraryWorkbench(self.database)

    def search(self, **filters: object) -> dict:
        return self.workbench.search({"filters": filters})

    def test_color_rating_move_and_literal_filters(self) -> None:
        self.assertEqual(self.search(white="Alpha", black="Beta")["total"], 1)
        self.assertEqual(self.search(white="Beta")["total"], 0)
        self.assertEqual(self.search(player="%")["total"], 0)
        self.assertEqual(self.search(event="' OR 1=1 --")["total"], 0)
        self.assertEqual(self.search(min_elo=2370)["total"], 0)
        self.assertEqual(self.search(max_elo=2200)["total"], 1)
        self.assertEqual(self.search(min_plies=7, max_plies=7)["total"], 1)
        self.assertEqual(self.search(eco="B", result="1-0")["total"], 1)
        self.assertEqual(self.search(eco="D", year_from=2021)["total"], 0)
        with self.assertRaises(ValueError):
            self.search(eco="Z99")

    def test_pagination_sort_and_offset_clamping(self) -> None:
        games = "\n\n".join(
            SAMPLE_PGN.split("\n\n[Event")[0].replace("Reference One", f"Game {index}")
            for index in range(31)
        )
        self.database.import_pgn_text(games)
        page = self.workbench.search(
            {"limit": 10, "offset": 10, "sort": "event", "direction": "asc"}
        )
        self.assertEqual(page["total"], 33)
        self.assertEqual(len(page["games"]), 10)
        tail = self.workbench.search({"limit": 10, "offset": 10000})
        self.assertEqual(tail["offset"], 30)
        self.assertEqual(len(tail["games"]), 3)
        empty = self.workbench.search({"filters": {"white": "nobody"}, "offset": 1000})
        self.assertEqual(empty["offset"], 0)

    def test_organization_is_atomic_and_notes_are_searchable(self) -> None:
        ids = [row["id"] for row in self.search()["games"]]
        self.workbench.organize(
            {
                "ids": ids,
                "changes": {
                    "favorite": True,
                    "folder": "Model games",
                    "tags": ["IQP", "IQP"],
                    "notes": "Practice conversion",
                },
            }
        )
        self.assertEqual(
            self.search(favorite=True, folder="model", tag="iqp", notes="conversion")["total"], 2
        )
        with self.assertRaises(ValueError):
            self.workbench.organize({"ids": [ids[0], 999], "changes": {"folder": "Broken"}})
        self.assertEqual(self.search(folder="Broken")["total"], 0)
        self.assertEqual(self.workbench.preview(ids[0])["game"]["tags"], ["IQP"])

    def test_preview_and_header_edit_preserve_comments_variations_and_clocks(self) -> None:
        pgn = (
            '[Event "Annotated"]\n[Result "*"]\n\n'
            "1. e4 {idea [%clk 0:01:23]} (1. d4 d5) e5 2. Nf3 *"
        )
        self.database.import_pgn_text(pgn)
        identifier = self.search(event="Annotated")["games"][0]["id"]
        preview = self.workbench.preview(identifier)
        self.assertEqual(len(preview["positions"]), 4)
        self.assertEqual(preview["positions"][1]["clock"], 83)
        self.assertEqual(preview["positions"][1]["alternatives"], 1)
        self.workbench.edit_headers(
            {
                "id": identifier,
                "revision": preview["revision"],
                "headers": {"White": "Player", "Result": "1-0"},
            }
        )
        revised = self.workbench.preview(identifier)
        game = chess.pgn.read_game(io.StringIO(revised["game"]["pgn"]))
        self.assertEqual(len(game.variations), 2)
        self.assertIn("idea", game.variations[0].comment)
        self.assertEqual(game.headers["Result"], "1-0")
        self.assertEqual(self.search(white="Player", result="1-0")["total"], 1)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.workbench.edit_headers(
                {"id": identifier, "revision": preview["revision"], "headers": {"White": "Stale"}}
            )
        with self.assertRaises(ValueError):
            self.workbench.edit_headers(
                {
                    "id": identifier,
                    "revision": revised["revision"],
                    "headers": {"White": 'Broken "header'},
                }
            )

    def test_same_line_duplicates_keep_distinct_annotations(self) -> None:
        self.database.import_pgn_text(
            SAMPLE_PGN.replace("Reference One", "Copy One").replace("Reference Two", "Copy Two")
        )
        matches = self.search(duplicates=True)
        self.assertEqual(matches["total"], 4)
        self.assertEqual(self.database.stats()["games"], 4)

    def test_saved_searches_and_export_survive_new_instance(self) -> None:
        self.workbench.views(
            {"action": "save", "name": "Sicilian", "filters": {"eco": "B", "favorite": True}}
        )
        again = LibraryWorkbench(LibraryDatabase(self.database.path))
        self.assertEqual(again.views({})["views"][0]["filters"]["eco"], "B")
        ids = [row["id"] for row in self.search()["games"]]
        exported = again.export(ids)["pgn"]
        stream = io.StringIO(exported)
        self.assertIsNotNone(chess.pgn.read_game(stream))
        self.assertIsNotNone(chess.pgn.read_game(stream))
        self.assertIsNone(chess.pgn.read_game(stream))
        with self.assertRaises(ValueError):
            again.export([999])
        again.views({"action": "delete", "name": "Sicilian"})
        self.assertEqual(again.views({})["views"], [])

    def test_report_player_head_to_head_and_unfinished(self) -> None:
        result = self.workbench.report({"player": "Alpha", "opponent": "Beta"})
        self.assertEqual(result["overall"]["games"], 2)
        self.assertEqual(result["dossier"][0]["wins"], 1)
        self.assertEqual(result["dossier"][1]["games"], 0)
        self.assertEqual(sum(row["games"] for row in result["openings"]), 2)
        self.assertEqual(sum(row["games"] for row in result["years"]), 2)
        self.assertEqual(self.workbench.report({"player": "Al"})["dossier"][0]["games"], 0)

    def test_legacy_catalog_backfill_is_idempotent_and_preserves_games(self) -> None:
        with closing(sqlite3.connect(self.database.path)) as connection, connection:
            for table in ["game_details", "library_views", "library_settings"]:
                connection.execute(f"DROP TABLE {table}")
        self.assertEqual(self.search()["total"], 2)
        self.assertEqual(self.search()["total"], 2)
        with closing(sqlite3.connect(self.database.path)) as connection, connection:
            self.assertEqual(
                connection.execute("SELECT SUM(plies) FROM game_details").fetchone()[0], 13
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM library_settings").fetchone()[0], 1
            )
        self.assertEqual(self.database.import_pgn_text(SAMPLE_PGN)["duplicates"], 2)

    def test_exact_position_normalizes_uncapturable_en_passant(self) -> None:
        board = chess.Board()
        board.push_uci("e2e4")
        self.assertEqual(self.search(fen=board.fen(en_passant="fen"))["total"], 1)
        self.assertEqual(self.search(fen=board.fen())["total"], 1)

    def test_payload_validation(self) -> None:
        for payload in (
            {"ids": []},
            {"ids": [True]},
            {"ids": [1], "changes": {"tags": "bad"}},
            {"ids": [1], "changes": {"folder": "x" * 81}},
        ):
            with self.assertRaises(ValueError):
                self.workbench.organize(payload)
        with self.assertRaises(ValueError):
            self.workbench.views({"action": "save", "name": "X", "filters": []})
        self.assertIsInstance(json.dumps(self.workbench.report({})), str)

    def test_opening_explorer_counts_a_repeated_game_only_once_per_move(self) -> None:
        self.database.import_pgn_text('[Event "Repeat"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 *')
        rows = self.database.opening_moves(chess.STARTING_FEN)["moves"]
        self.assertEqual(next(row for row in rows if row["move_uci"] == "g1f3")["games"], 1)
        self.assertEqual(self.database.search_games({"max_ply": 0})["total"], 3)

    def test_study_variant_is_independent_of_live_game_variant(self) -> None:
        from gui.server import GameSession

        fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
        session = GameSession()
        session.chess960 = True
        standard = session.position_from_fen(fen, chess960=False)
        self.assertEqual(standard["variant"], "standard")
        self.assertIn("e1g1", standard["legal_moves"])
        moved = session.variation_move(fen, "e1g1", chess960=False)
        self.assertEqual(moved["variant"], "standard")
        session.chess960 = False
        randomized = session.position_from_fen(fen, chess960=True)
        self.assertIn("e1h1", randomized["legal_moves"])
        self.assertEqual(session.variation_move(fen, "e1h1", chess960=True)["variant"], "chess960")

    def test_workspace_backup_roundtrips_folders_notes_and_saved_searches(self) -> None:
        import os
        from unittest.mock import patch

        from gui import workspace

        identifier = self.search()["games"][0]["id"]
        self.workbench.organize(
            {
                "ids": [identifier],
                "changes": {
                    "notes": "Keep me",
                    "folder": "Models",
                    "tags": ["test"],
                    "favorite": True,
                },
            }
        )
        self.workbench.views({"action": "save", "name": "Models", "filters": {"folder": "Models"}})
        with patch.dict(os.environ, {"FUNCHESS_DATA_DIR": self.temp.name}):
            bundle = workspace.create_bundle({}, True)
        try:
            with patch.dict(
                os.environ, {"FUNCHESS_DATA_DIR": str(Path(self.temp.name) / "restored")}
            ):
                workspace.restore_bundle(bundle["token"])
                restored = LibraryWorkbench(LibraryDatabase())
                self.assertEqual(restored.search({"filters": {"favorite": True}})["total"], 1)
                self.assertEqual(restored.preview(identifier)["game"]["notes"], "Keep me")
                self.assertEqual(restored.views({})["views"][0]["name"], "Models")
                restored.undo_organization(restored.collections()["undo"][0]["id"])
                self.assertEqual(restored.preview(identifier)["game"]["notes"], "")
        finally:
            workspace.upload({"action": "cancel", "token": bundle["token"]})

    def test_tag_merge_remove_and_limit_rollback(self) -> None:
        ids = [row["id"] for row in self.search()["games"]]
        self.workbench.organize({"ids": ids, "changes": {"tags": ["Model", "IQP"]}})
        self.workbench.organize(
            {"ids": ids, "changes": {"tags": ["model", "Endgame"]}, "tag_mode": "add"}
        )
        self.assertEqual(
            self.workbench.preview(ids[0])["game"]["tags"], ["Model", "IQP", "Endgame"]
        )
        self.workbench.organize({"ids": ids, "changes": {"tags": ["iqp"]}, "tag_mode": "remove"})
        self.assertEqual(self.workbench.preview(ids[0])["game"]["tags"], ["Model", "Endgame"])
        self.workbench.organize({"ids": [ids[1]], "changes": {"tags": [str(n) for n in range(20)]}})
        with self.assertRaisesRegex(ValueError, "20 tags"):
            self.workbench.organize({"ids": ids, "changes": {"tags": ["New"]}, "tag_mode": "add"})
        self.assertEqual(self.search(tag="New")["total"], 0)

    def test_undo_is_atomic_and_preserves_independent_changes(self) -> None:
        ids = [row["id"] for row in self.search()["games"]]
        older = self.workbench.organize({"ids": ids, "changes": {"folder": "Models"}})
        newer = self.workbench.organize({"ids": [ids[1]], "changes": {"folder": "Later"}})
        self.workbench.organize({"ids": ids, "changes": {"notes": "Independent"}})
        with self.assertRaisesRegex(ValueError, "nothing was changed"):
            self.workbench.undo_organization(older["undo_id"])
        self.assertEqual(self.workbench.preview(ids[0])["game"]["folder"], "Models")
        self.workbench.undo_organization(newer["undo_id"])
        fresh_instance = LibraryWorkbench(LibraryDatabase(self.database.path))
        self.assertEqual(fresh_instance.undo_organization(older["undo_id"])["restored"], 2)
        self.assertEqual(self.search(unfiled=True, notes="Independent")["total"], 2)
        with self.assertRaisesRegex(ValueError, "expired"):
            self.workbench.undo_organization(older["undo_id"])

    def test_undo_retention_and_noop(self) -> None:
        identifier = self.search()["games"][0]["id"]
        self.assertIsNone(
            self.workbench.organize({"ids": [identifier], "changes": {"favorite": False}})[
                "undo_id"
            ]
        )
        for n in range(12):
            self.workbench.organize({"ids": [identifier], "changes": {"notes": str(n)}})
        self.assertEqual(len(self.workbench.collections()["undo"]), 10)
        for _ in range(10):
            self.workbench.undo_organization(self.workbench.collections()["undo"][0]["id"])
        self.assertEqual(self.workbench.preview(identifier)["game"]["notes"], "1")

    def test_note_save_rejects_stale_baseline(self) -> None:
        identifier = self.search()["games"][0]["id"]
        first = self.workbench.organize(
            {"ids": [identifier], "changes": {"notes": "First"}, "expected_notes": ""}
        )
        with self.assertRaisesRegex(ValueError, "notes changed"):
            self.workbench.organize(
                {"ids": [identifier], "changes": {"notes": "Stale"}, "expected_notes": ""}
            )
        self.assertEqual(self.workbench.preview(identifier)["game"]["notes"], "First")
        self.workbench.undo_organization(first["undo_id"])
        self.assertEqual(self.workbench.preview(identifier)["game"]["notes"], "")

    def test_collection_counts_and_exact_folder_searches(self) -> None:
        ids = [row["id"] for row in self.search()["games"]]
        self.workbench.organize(
            {"ids": [ids[0]], "changes": {"folder": "Models", "favorite": True, "tags": ["IQP"]}}
        )
        totals = self.workbench.collections()
        self.assertEqual((totals["games"], totals["favorites"], totals["unfiled"]), (2, 1, 1))
        self.workbench.organize(
            {"ids": [ids[1]], "changes": {"folder": "Models/endgames", "tags": ["iqp"]}}
        )
        self.assertEqual(self.search(folder="Models")["total"], 2)
        self.assertEqual(self.search(folder="Models", folder_exact=True)["total"], 1)
        self.assertEqual(self.search(unfiled=True)["total"], 0)
        self.assertEqual(self.workbench.collections()["tags"][0]["games"], 2)

    def test_header_calendar_validation_and_saved_snapshot(self) -> None:
        preview = self.workbench.preview(self.search()["games"][0]["id"])
        for changes in ({"Date": "2025.02.29"}, {"Date": "2026.13.01"}, {"ECO": "Z42"}):
            with self.assertRaises(ValueError):
                self.workbench.edit_headers(
                    {
                        "id": preview["game"]["id"],
                        "revision": preview["revision"],
                        "headers": changes,
                    }
                )
        result = self.workbench.edit_headers(
            {
                "id": preview["game"]["id"],
                "revision": preview["revision"],
                "headers": {"White": "Edited", "Date": "2024.02.29"},
            }
        )
        fresh = self.workbench.preview(preview["game"]["id"])
        self.assertEqual(result["revision"], fresh["revision"])
        self.assertEqual(result["pgn"], fresh["game"]["pgn"])
        self.assertEqual(result["metadata"]["white"], "Edited")
        self.assertEqual(result["headers"]["Date"], "2024.02.29")

    def test_undo_accepts_full_length_unicode_tags(self) -> None:
        identifier = self.search()["games"][0]["id"]
        tags = [chr(0x1F600 + n) * 40 for n in range(20)]
        self.workbench.organize({"ids": [identifier], "changes": {"tags": tags}})
        removal = self.workbench.organize({"ids": [identifier], "changes": {"tags": []}})
        self.workbench.undo_organization(removal["undo_id"])
        self.assertEqual(self.workbench.preview(identifier)["game"]["tags"], tags)

    def test_explorer_partitions_repeated_positions_and_terminal_games(self) -> None:
        self.database.import_pgn_text(
            '[Event "Loop"]\n[Result "*"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. e4 *\n\n'
            '[Event "Empty"]\n[Result "*"]\n\n*'
        )
        result = self.workbench.explorer({"fen": chess.STARTING_FEN})
        self.assertEqual((result["games"], result["ended"]), (4, 1))
        self.assertEqual(sum(row["games"] for row in result["moves"]), 3)
        moves = {row["move_uci"]: row for row in result["moves"]}
        self.assertEqual(moves["e2e4"]["games"], 1)
        self.assertEqual(moves["g1f3"]["unfinished"], 1)
        self.assertIsNone(moves["g1f3"]["white_score"])
        self.assertEqual(moves["e2e4"]["white_score"], 1)
        self.assertEqual(moves["d2d4"]["white_score"], 0.5)
        self.assertEqual(moves["e2e4"]["average_elo"], 2375)

    def test_explorer_uses_filters_and_returns_legal_child_positions(self) -> None:
        identifier = self.search(white="Alpha")["games"][0]["id"]
        self.workbench.organize({"ids": [identifier], "changes": {"tags": ["Model"]}})
        result = self.workbench.explorer({"filters": {"tag": "Model"}})
        self.assertEqual(result["games"], 1)
        row = result["moves"][0]
        board = chess.Board()
        board.push_uci(row["move_uci"])
        self.assertEqual(row["fen"], board.fen())
        self.assertEqual(row["san"], "e4")
        reply = self.workbench.explorer({"fen": row["fen"], "filters": {"tag": "Model"}})
        self.assertEqual(reply["moves"][0]["san"], "c5")
        # A raw FEN can include an uncapturable en-passant target.
        self.assertEqual(self.workbench.explorer({"fen": board.fen(en_passant="fen")})["games"], 1)
        self.assertEqual(self.workbench.explorer({"filters": {"tag": "absent"}})["moves"], [])

    def test_variant_search_and_explorer_keep_chess960_separate(self) -> None:
        fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1"
        for variant, event in (("Standard", "Standard castle"), ("Chess960", "960 castle")):
            self.database.import_pgn_text(
                f'[Event "{event}"]\n[Variant "{variant}"]\n[SetUp "1"]\n'
                f'[FEN "{fen}"]\n[Result "*"]\n\n1. O-O *'
            )
        for variant, uci in (("standard", "e1g1"), ("chess960", "e1h1")):
            self.assertEqual(self.search(fen=fen, variant=variant)["total"], 1)
            result = self.workbench.explorer({"fen": fen, "variant": variant})
            self.assertEqual(result["games"], 1)
            self.assertEqual(result["moves"][0]["move_uci"], uci)
            self.assertEqual(result["moves"][0]["san"], "O-O")
            self.assertEqual(chess.Board(result["moves"][0]["fen"]).king(chess.WHITE), chess.G1)
        with self.assertRaises(ValueError):
            self.search(variant="atomic")
        with self.assertRaises(ValueError):
            self.workbench.explorer({"variant": "atomic"})
        with self.assertRaises(ValueError):
            self.workbench.explorer({"fen": "8/8/8/8/8/8/8/8 w - - 0 1"})
