"""Additive library organization schema with restart-safe legacy backfill."""

from __future__ import annotations

import hashlib
import sqlite3


def line_key(fen: str, moves: str) -> str:
    return hashlib.sha256(f"{fen}\n{moves}".encode()).hexdigest()


def ensure_catalog(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS game_details (
            game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
            plies INTEGER NOT NULL, line_key TEXT NOT NULL,
            favorite INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
            folder TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_details_line ON game_details(line_key);
        CREATE INDEX IF NOT EXISTS idx_details_folder ON game_details(folder);
        CREATE TABLE IF NOT EXISTS library_undo (
            id TEXT PRIMARY KEY, created_at REAL NOT NULL, label TEXT NOT NULL, edits TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS library_views (name TEXT PRIMARY KEY, filters TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS library_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    if connection.execute("SELECT 1 FROM library_settings WHERE key='catalog-v1'").fetchone():
        return
    with connection:
        rows = connection.execute("""
            SELECT g.id, g.initial_fen FROM games g
            WHERE NOT EXISTS (SELECT 1 FROM game_details d WHERE d.game_id=g.id)
        """)
        for row in rows:
            moves = [
                str(p[0])
                for p in connection.execute(
                    "SELECT move_uci FROM positions WHERE game_id=? "
                    "AND move_uci IS NOT NULL ORDER BY ply",
                    (row[0],),
                )
            ]
            connection.execute(
                "INSERT INTO game_details(game_id,plies,line_key) VALUES(?,?,?)",
                (row[0], len(moves), line_key(str(row[1]), " ".join(moves))),
            )
        connection.execute("INSERT INTO library_settings VALUES('catalog-v1','ready')")
