"""Catch Windows file-lock regressions without relying on GC or Windows unlink rules."""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import chess

from gui import workspace
from librarydb.store import LibraryDatabase
from openingbook.store import OpeningBook


class SQLiteLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = patch.dict(os.environ, {"FUNCHESS_DATA_DIR": str(self.root / "profile")})
        self.profile.start()
        self.addCleanup(self.profile.stop)

    @contextmanager
    def tracked_connections(self) -> Iterator[None]:
        connect = sqlite3.connect
        connections: list[sqlite3.Connection] = []

        def tracked(*args: object, **kwargs: object) -> sqlite3.Connection:
            connection = connect(*args, **kwargs)
            connections.append(connection)  # Strong references prevent GC from hiding a leak.
            return connection

        with patch("sqlite3.connect", side_effect=tracked):
            try:
                yield
            finally:
                leaks = 0
                for connection in connections:
                    try:
                        connection.execute("SELECT 1")
                    except sqlite3.ProgrammingError:
                        continue
                    leaks += 1
                    connection.close()  # Allow Windows cleanup even when the assertion fails.
                self.assertGreater(len(connections), 0)
                self.assertEqual(leaks, 0, "SQLite handles survived their operation scope")

    def test_backup_restore_and_store_operations_close_every_handle(self) -> None:
        with self.tracked_connections():
            database = LibraryDatabase()
            database.import_pgn_text('[Event "Lifecycle"]\n\n1. e4 *')
            book = OpeningBook()
            book.add_move(chess.STARTING_FEN, "d2d4")
            book.moves(chess.STARTING_FEN)
            bundle = workspace.create_bundle({}, True)
            self.addCleanup(workspace.upload, {"action": "cancel", "token": bundle["token"]})
            with patch.dict(os.environ, {"FUNCHESS_DATA_DIR": str(self.root / "fresh")}):
                workspace.restore_bundle(bundle["token"])
                self.assertEqual(OpeningBook().stats()["moves"], 1)
                self.assertEqual(LibraryDatabase().stats()["games"], 1)

    def test_snapshot_closes_source_when_destination_cannot_open(self) -> None:
        source = self.root / "source.sqlite3"
        with self.tracked_connections(), self.assertRaises(sqlite3.OperationalError):
            workspace._snapshot(source, self.root / "missing" / "destination.sqlite3")

    def test_snapshot_closes_both_handles_when_backup_fails(self) -> None:
        source, target = self.root / "source.sqlite3", self.root / "target.sqlite3"
        source.write_bytes(b"not a SQLite database")
        with self.tracked_connections(), self.assertRaises(sqlite3.DatabaseError):
            workspace._snapshot(source, target)

    def test_restore_closes_validation_handles_on_schema_rejection(self) -> None:
        database = LibraryDatabase()
        with database._connect() as connection:
            connection.execute("ALTER TABLE games ADD COLUMN unexpected TEXT")
        bundle = workspace.create_bundle({}, True)
        self.addCleanup(workspace.upload, {"action": "cancel", "token": bundle["token"]})
        with self.tracked_connections(), self.assertRaisesRegex(ValueError, "Unsupported columns"):
            workspace.restore_bundle(bundle["token"])
