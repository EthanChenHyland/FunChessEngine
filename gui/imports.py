"""Resumable reference PGN ingestion using bounded batches and persistent checkpoints."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any, BinaryIO

import chess.pgn

from gui.jobs import check_cancelled, progress
from gui.workspace import LOCK, import_fingerprint
from librarydb.store import LibraryDatabase


class BoundedPGN(io.TextIOWrapper):
    def __init__(self, stream: BinaryIO) -> None:
        super().__init__(stream, encoding="utf-8-sig")
        self.game_bytes = 0

    def readline(self, size: int | None = -1) -> str:  # type: ignore[override]
        # TextIOWrapper is textual; typeshed also inherits the binary _IOBase signature.
        check_cancelled()
        line = super().readline(1024 * 1024 + 1)
        self.game_bytes += len(line.encode("utf-8"))
        if len(line) > 1024 * 1024 or self.game_bytes > 2 * 1024 * 1024:
            raise ValueError("A single PGN game exceeds the 2 MB parsing limit.")
        return line


def import_reference_file(database: LibraryDatabase, path: Path, source: str) -> dict[str, Any]:
    identity = import_fingerprint(path)
    totals = {"parsed": 0, "imported": 0, "duplicates": 0, "positions": 0}
    with database._connect() as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS import_checkpoints "
            "(digest TEXT PRIMARY KEY, offset INTEGER NOT NULL, stats TEXT NOT NULL)"
        )
        checkpoint = connection.execute(
            "SELECT offset, stats FROM import_checkpoints WHERE digest=?", (identity,)
        ).fetchone()
    connection.close()
    offset = int(checkpoint[0]) if checkpoint else 0
    if checkpoint:
        totals.update(json.loads(checkpoint[1]))
    with path.open("rb") as raw, BoundedPGN(raw) as stream:
        stream.seek(offset)
        reader = stream
        exhausted = False
        while not exhausted:
            batch: list[str] = []
            for _ in range(100):
                check_cancelled()
                reader.game_bytes = 0
                game = chess.pgn.read_game(reader)
                if game is None:
                    exhausted = True
                    break
                if game.errors:
                    raise ValueError(f"Invalid PGN near game {totals['parsed'] + len(batch) + 1}.")
                batch.append(str(game))
            if batch:
                if totals["parsed"] + len(batch) > 100_000:
                    raise ValueError("A reference import supports at most 100,000 games per file.")
                with LOCK:
                    result = database.import_pgn_text(
                        "\n\n".join(batch), source=source, max_games=len(batch)
                    )
                    for key in totals:
                        totals[key] += result[key]
                    with database._connect() as connection:
                        connection.execute(
                            "INSERT OR REPLACE INTO import_checkpoints VALUES(?,?,?)",
                            (identity, stream.tell(), json.dumps(totals)),
                        )
                    connection.close()
            progress(
                {
                    "completed": stream.tell(),
                    "total": path.stat().st_size,
                    "message": f"{totals['parsed']} games scanned; {totals['imported']} indexed",
                    "partial": dict(totals),
                }
            )
    return {**totals, "resumed": bool(offset), "complete": True}
