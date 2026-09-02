"""Editable local opening book with optional Polyglot import."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import chess
import chess.polyglot

from librarydb.connections import DATABASE_LOCK
from librarydb.store import default_data_dir, fen_key


def default_book_path() -> Path:
    return default_data_dir() / "opening-book.sqlite3"


class OpeningBook:
    """Small SQLite opening book kept outside the competition engine package."""

    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else default_book_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        with DATABASE_LOCK:
            connection = sqlite3.connect(self.path)
            connection.row_factory = sqlite3.Row
            try:
                with connection:
                    yield connection
            finally:
                connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            existing = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(book_moves)").fetchall()
            }
            if existing and "profile" not in existing:
                connection.executescript(
                    """
                    ALTER TABLE book_moves RENAME TO book_moves_v1;
                    CREATE TABLE book_moves (
                        profile TEXT NOT NULL DEFAULT 'default',
                        fen_key TEXT NOT NULL,
                        move_uci TEXT NOT NULL,
                        weight INTEGER NOT NULL DEFAULT 1,
                        learn INTEGER NOT NULL DEFAULT 0,
                        source TEXT NOT NULL DEFAULT 'local',
                        PRIMARY KEY (profile, fen_key, move_uci)
                    );
                    INSERT INTO book_moves(profile, fen_key, move_uci, weight, learn, source)
                    SELECT 'default', fen_key, move_uci, weight, learn, source FROM book_moves_v1;
                    DROP TABLE book_moves_v1;
                    """
                )
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS book_moves (
                    profile TEXT NOT NULL DEFAULT 'default',
                    fen_key TEXT NOT NULL,
                    move_uci TEXT NOT NULL,
                    weight INTEGER NOT NULL DEFAULT 1,
                    learn INTEGER NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT 'local',
                    PRIMARY KEY (profile, fen_key, move_uci)
                );
                CREATE INDEX IF NOT EXISTS idx_book_position
                    ON book_moves(profile, fen_key, weight DESC, learn DESC);
                """
            )

    def add_move(
        self,
        fen: str,
        move_uci: str,
        *,
        weight: int = 1,
        learn: int = 0,
        source: str = "local",
        profile: str = "default",
    ) -> dict[str, Any]:
        board = chess.Board(fen)
        try:
            move = board.parse_uci(move_uci)
        except ValueError as exc:
            raise ValueError("Opening-book move must be legal UCI for this position.") from exc
        if move not in board.legal_moves:
            raise ValueError("Opening-book move must be legal UCI for this position.")
        key = fen_key(board.fen())
        normalized = board.uci(move)
        bounded_weight = max(0, min(65_535, int(weight)))
        bounded_learn = max(-2_000_000_000, min(2_000_000_000, int(learn)))
        profile_name = str(profile or "default").strip()[:48] or "default"
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO book_moves(profile, fen_key, move_uci, weight, learn, source)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile, fen_key, move_uci) DO UPDATE SET
                    weight=excluded.weight,
                    learn=excluded.learn,
                    source=excluded.source
                """,
                (
                    profile_name,
                    key,
                    normalized,
                    bounded_weight,
                    bounded_learn,
                    str(source)[:80],
                ),
            )
        return {
            "profile": profile_name,
            "fen_key": key,
            "move": normalized,
            "weight": bounded_weight,
            "learn": bounded_learn,
            "source": str(source)[:80],
        }

    def remove_move(self, fen: str, move_uci: str, *, profile: str = "default") -> bool:
        board = chess.Board(fen)
        move = board.parse_uci(move_uci)
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM book_moves WHERE profile=? AND fen_key=? AND move_uci=?",
                (str(profile or "default")[:48], fen_key(board.fen()), board.uci(move)),
            )
            return cursor.rowcount > 0

    def moves(
        self,
        fen: str,
        *,
        depth_limit: int | None = None,
        profile: str = "default",
    ) -> list[dict[str, Any]]:
        board = chess.Board(fen)
        if depth_limit is not None and board.ply() >= max(0, int(depth_limit)):
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT move_uci, weight, learn, source
                FROM book_moves
                WHERE profile=? AND fen_key=?
                ORDER BY weight DESC, learn DESC, move_uci
                """,
                (str(profile or "default")[:48], fen_key(board.fen())),
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                move = board.parse_uci(str(row["move_uci"]))
            except ValueError:
                continue
            if move not in board.legal_moves:
                continue
            result.append(
                {
                    "move": board.uci(move),
                    "san": board.san(move),
                    "weight": int(row["weight"]),
                    "learn": int(row["learn"]),
                    "source": str(row["source"]),
                }
            )
        return result

    def learn_result(
        self,
        fen: str,
        move_uci: str,
        score: float,
        *,
        profile: str = "default",
    ) -> bool:
        """Adjust a local move's learning score from a 0/0.5/1 result."""

        delta = round((max(0.0, min(1.0, float(score))) - 0.5) * 20)
        board = chess.Board(fen)
        move = board.parse_uci(move_uci)
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE book_moves
                SET learn=MAX(-2000000000, MIN(2000000000, learn + ?))
                WHERE profile=? AND fen_key=? AND move_uci=?
                """,
                (delta, str(profile or "default")[:48], fen_key(board.fen()), board.uci(move)),
            )
            return cursor.rowcount > 0

    def import_polyglot(self, path: Path | str, *, source: str | None = None) -> dict[str, Any]:
        candidate = Path(path).expanduser().resolve()
        if not candidate.is_file():
            raise ValueError("Polyglot book path must point to an existing file.")
        if candidate.stat().st_size > 256 * 1024 * 1024:
            raise ValueError("Polyglot book is larger than the 256 MB local import limit.")
        imported = 0
        skipped = 0
        source_name = (source or candidate.name)[:80]
        with chess.polyglot.open_reader(str(candidate)) as reader:
            for _entry in reader:
                # Polyglot records contain only a zobrist key rather than a FEN,
                # so enumerate through the reader's position-aware API below.
                # Raw entries cannot be mapped back to a position losslessly.
                skipped += 1
        # A standalone Polyglot file cannot be reverse-mapped from keys to FENs.
        # Import becomes useful when paired with a PGN-position index; expose a
        # separate indexed import method rather than pretending otherwise.
        return {
            "imported": imported,
            "skipped_unmapped": skipped,
            "source": source_name,
            "reason": "Polyglot keys need known positions; use import_polyglot_for_positions.",
        }

    def import_polyglot_for_positions(
        self,
        path: Path | str,
        fens: list[str],
        *,
        source: str | None = None,
        profile: str = "default",
    ) -> dict[str, Any]:
        candidate = Path(path).expanduser().resolve()
        if not candidate.is_file():
            raise ValueError("Polyglot book path must point to an existing file.")
        if candidate.stat().st_size > 256 * 1024 * 1024:
            raise ValueError("Polyglot book is larger than the 256 MB local import limit.")
        source_name = (source or candidate.name)[:80]
        imported = 0
        positions = 0
        with chess.polyglot.open_reader(str(candidate)) as reader:
            for fen in fens[:100_000]:
                board = chess.Board(fen)
                rows = list(reader.find_all(board))
                if not rows:
                    continue
                positions += 1
                for entry in rows:
                    self.add_move(
                        board.fen(),
                        board.uci(entry.move),
                        weight=int(entry.weight),
                        learn=int(entry.learn),
                        source=source_name,
                        profile=profile,
                    )
                    imported += 1
        return {"imported": imported, "positions": positions, "source": source_name}

    def stats(self, profile: str | None = None) -> dict[str, int]:
        with self._connect() as connection:
            if profile:
                row = connection.execute(
                    """
                    SELECT COUNT(*) AS moves, COUNT(DISTINCT fen_key) AS positions
                    FROM book_moves WHERE profile=?
                    """,
                    (str(profile)[:48],),
                ).fetchone()
            else:
                row = connection.execute(
                    "SELECT COUNT(*) AS moves, COUNT(DISTINCT fen_key) AS positions FROM book_moves"
                ).fetchone()
        assert row is not None
        return {"moves": int(row["moves"]), "positions": int(row["positions"])}
