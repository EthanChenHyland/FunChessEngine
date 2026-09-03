"""Database browsing, organization and reports; independent of the live chess session."""

from __future__ import annotations

import hashlib
import io
import json
import re
import sqlite3
import time
import uuid
from datetime import date
from typing import Any

import chess
import chess.pgn

from librarydb.store import LibraryDatabase

SORTS = {
    "date": "g.game_date",
    "white": "g.white COLLATE NOCASE",
    "black": "g.black COLLATE NOCASE",
    "event": "g.event COLLATE NOCASE",
    "eco": "g.eco",
    "result": "g.result",
    "rating": "MAX(COALESCE(g.white_elo,0),COALESCE(g.black_elo,0))",
    "moves": "d.plies",
}
TEXT_FILTERS = {key: f"g.{key}" for key in ("white", "black", "event", "site", "opening", "source")}
TEXT_FILTERS.update({"folder": "d.folder", "notes": "d.notes", "annotation": "g.pgn"})
ORGANIZATION_FIELDS = {"favorite", "folder", "tags", "notes"}
HEADERS = {
    "Event": "event",
    "Site": "site",
    "Date": "game_date",
    "Round": "round",
    "White": "white",
    "Black": "black",
    "WhiteElo": "white_elo",
    "BlackElo": "black_elo",
    "Result": "result",
    "ECO": "eco",
    "Opening": "opening",
}


def clean_tags(value: Any) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(tag, str) or len(tag) > 40 for tag in value
    ):
        raise ValueError("Tags must contain at most 40 characters each.")
    unique: dict[str, str] = {}
    for tag in value:
        if tag.strip():
            unique.setdefault(tag.strip().casefold(), tag.strip())
    if len(unique) > 20:
        raise ValueError("A game can have at most 20 tags. Remove some before adding more.")
    return list(unique.values())


def literal_like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def where_clause(filters: dict[str, Any]) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    values: list[Any] = []
    for key, column in TEXT_FILTERS.items():
        if key == "folder" and filters.get("folder_exact"):
            clauses.append("d.folder=?")
            values.append(str(filters.get(key, "")))
        elif filters.get(key):
            clauses.append(f"{column} LIKE ? ESCAPE '\\'")
            values.append(literal_like(str(filters[key]).strip()[:300]))
    if filters.get("unfiled"):
        clauses.append("d.folder=''")
    if filters.get("player"):
        clauses.append("(g.white LIKE ? ESCAPE '\\' OR g.black LIKE ? ESCAPE '\\')")
        values.extend([literal_like(str(filters["player"])[:200])] * 2)
    for key, column, operator in (
        ("year_from", "g.year", ">="),
        ("year_to", "g.year", "<="),
        ("min_elo", "MIN(g.white_elo,g.black_elo)", ">="),
        ("max_elo", "MAX(g.white_elo,g.black_elo)", "<="),
        ("min_plies", "d.plies", ">="),
        ("max_plies", "d.plies", "<="),
    ):
        if filters.get(key) not in (None, ""):
            value = int(filters[key])
            if not 0 <= value <= 10000:
                raise ValueError(f"Invalid {key} range.")
            clauses.append(f"{column} {operator} ?")
            values.append(value)
    if filters.get("result"):
        if filters["result"] not in {"1-0", "0-1", "1/2-1/2", "*"}:
            raise ValueError("Invalid game result.")
        clauses.append("g.result=?")
        values.append(filters["result"])
    if filters.get("eco"):
        eco = str(filters["eco"]).upper()
        if not re.fullmatch(r"[A-E][0-9]{0,2}", eco):
            raise ValueError("ECO must be A-E followed by zero, one, or two digits.")
        clauses.append("g.eco LIKE ?")
        values.append(eco + "%")
    if filters.get("favorite"):
        clauses.append("d.favorite=1")
    if filters.get("tag"):
        clauses.append("EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value=? COLLATE NOCASE)")
        values.append(str(filters["tag"])[:40])
    if filters.get("duplicates"):
        clauses.append(
            "d.line_key IN (SELECT line_key FROM game_details GROUP BY line_key HAVING COUNT(*)>1)"
        )
    if filters.get("fen"):
        board = chess.Board(str(filters["fen"]))
        clauses.append("EXISTS (SELECT 1 FROM positions p WHERE p.game_id=g.id AND p.fen_key=?)")
        values.append(" ".join(board.fen(en_passant="legal").split()[:4]))
    return " AND ".join(clauses) or "1", values


class LibraryWorkbench:
    def __init__(self, database: LibraryDatabase) -> None:
        self.database = database

    def search(self, payload: dict[str, Any]) -> dict[str, Any]:
        filters = payload.get("filters", {})
        if not isinstance(filters, dict):
            raise ValueError("Filters must be an object.")
        where, values = where_clause(filters)
        order = SORTS.get(str(payload.get("sort", "date")), SORTS["date"])
        direction = "ASC" if payload.get("direction") == "asc" else "DESC"
        limit = max(10, min(100, int(payload.get("limit", 25))))
        offset = max(0, int(payload.get("offset", 0)))
        with self.database._connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM games g JOIN game_details d ON d.game_id=g.id WHERE {where}",
                values,
            ).fetchone()[0]
            offset = min(offset, max(0, ((total - 1) // limit) * limit))
            rows = connection.execute(
                f"""
                SELECT g.id,g.white,g.black,g.white_elo,g.black_elo,g.event,g.site,g.game_date,
                       g.result,g.eco,g.opening,g.source,d.plies,d.favorite,d.tags,d.folder
                FROM games g JOIN game_details d ON d.game_id=g.id WHERE {where}
                ORDER BY {order} {direction}, g.id {direction} LIMIT ? OFFSET ?
            """,
                [*values, limit, offset],
            ).fetchall()
        games = [{**dict(row), "tags": json.loads(row["tags"])} for row in rows]
        return {"games": games, "total": total, "offset": offset, "limit": limit}

    def preview(self, game_id: int) -> dict[str, Any]:
        with self.database._connect() as connection:
            found = connection.execute(
                """
                SELECT g.*,d.favorite,d.folder,d.tags,d.notes,d.plies
                FROM games g JOIN game_details d ON d.game_id=g.id WHERE g.id=?
            """,
                (game_id,),
            ).fetchone()
        if found is None:
            raise ValueError("Game no longer exists. Refresh the database.")
        record = dict(found)
        record["tags"] = json.loads(record["tags"])
        game = chess.pgn.read_game(io.StringIO(record["pgn"]))
        if game is None or game.errors:
            raise ValueError("Stored game has invalid PGN.")
        board = game.board()
        positions: list[dict[str, Any]] = [
            {"fen": board.fen(), "san": "Start", "comment": game.comment}
        ]
        for node in game.mainline():
            san = board.san(node.move)
            label = f"{board.fullmove_number}{'.' if board.turn else '…'} {san}"
            board.push(node.move)
            positions.append(
                {
                    "fen": board.fen(),
                    "san": san,
                    "label": label,
                    "uci": node.move.uci(),
                    "comment": node.comment,
                    "nags": sorted(node.nags),
                    "alternatives": len(node.parent.variations) - 1 if node.parent else 0,
                    "check": board.is_check(),
                    "clock": node.clock(),
                }
            )
        return {
            "game": record,
            "headers": dict(game.headers),
            "positions": positions,
            "revision": hashlib.sha256(record["pgn"].encode()).hexdigest(),
        }

    def organize(self, payload: dict[str, Any]) -> dict[str, Any]:
        ids = self._ids(payload.get("ids"))
        changes = payload.get("changes")
        if not isinstance(changes, dict) or not changes or set(changes) - ORGANIZATION_FIELDS:
            raise ValueError("Choose favorite, folder, tags, or notes to update.")
        if "favorite" in changes and not isinstance(changes["favorite"], bool):
            raise ValueError("Favorite must be true or false.")
        tag_mode = payload.get("tag_mode", "replace")
        if tag_mode not in {"replace", "add", "remove"}:
            raise ValueError("Tag mode must be add, remove, or replace.")
        if "tags" in changes:
            changes = {**changes, "tags": clean_tags(changes["tags"])}
        for key, limit in (("folder", 80), ("notes", 10000)):
            if key in changes and (not isinstance(changes[key], str) or len(changes[key]) > limit):
                raise ValueError(f"{key} must contain at most {limit} characters.")
        if "expected_notes" in payload and (
            len(ids) != 1 or not isinstance(payload["expected_notes"], str)
        ):
            raise ValueError(
                "Notes revision checks require a single game and its previous note text."
            )
        edits: list[dict[str, Any]] = []
        with self.database._connect() as connection:
            for identifier in ids:
                row = connection.execute(
                    "SELECT * FROM game_details WHERE game_id=?", (identifier,)
                ).fetchone()
                if row is None:
                    raise ValueError("A selected game no longer exists; no games were changed.")
                if "expected_notes" in payload and row["notes"] != payload["expected_notes"]:
                    raise ValueError(
                        "These notes changed since the preview opened. "
                        "Reload the game before saving."
                    )
                after = dict(changes)
                if "tags" in after:
                    requested = after["tags"]
                    existing = json.loads(row["tags"])
                    if tag_mode == "add":
                        after["tags"] = clean_tags([*existing, *requested])
                    elif tag_mode == "remove":
                        remove = {tag.casefold() for tag in requested}
                        after["tags"] = [tag for tag in existing if tag.casefold() not in remove]
                    after["tags"] = json.dumps(after["tags"])
                after = {key: value for key, value in after.items() if row[key] != value}
                if after:
                    edits.append(
                        {
                            "id": identifier,
                            "before": {key: row[key] for key in after},
                            "after": after,
                        }
                    )
            if not edits:
                return {"updated": 0, "undo_id": None}
            encoded = json.dumps(edits)
            if len(encoded.encode()) > 4 * 1024 * 1024:
                raise ValueError("This edit exceeds the 4 MB undo limit. Select fewer games.")
            for edit in edits:
                after = edit["after"]
                connection.execute(
                    f"UPDATE game_details SET {','.join(f'{key}=?' for key in after)} "
                    "WHERE game_id=?",
                    [*after.values(), edit["id"]],
                )
            undo_id = uuid.uuid4().hex
            label = f"{', '.join(changes).capitalize()} - {len(edits)} game(s)"
            connection.execute(
                "INSERT INTO library_undo VALUES(?,?,?,?)",
                (undo_id, time.time(), label, encoded),
            )
            connection.execute("""DELETE FROM library_undo WHERE id NOT IN
                (SELECT id FROM library_undo ORDER BY created_at DESC,rowid DESC LIMIT 10)""")
        return {"updated": len(edits), "undo_id": undo_id}

    def collections(self) -> dict[str, Any]:
        with self.database._connect() as connection:
            totals = dict(
                connection.execute("""SELECT COUNT(*) AS games,
                COALESCE(SUM(favorite=1),0) AS favorites,
                COALESCE(SUM(folder=''),0) AS unfiled FROM game_details""").fetchone()
            )
            folders = [
                dict(row)
                for row in connection.execute("""
                SELECT folder AS name,COUNT(*) AS games FROM game_details WHERE folder!=''
                GROUP BY folder ORDER BY folder COLLATE NOCASE LIMIT 100""")
            ]
            tags = [
                dict(row)
                for row in connection.execute("""
                SELECT j.value AS name,COUNT(DISTINCT d.game_id) AS games
                FROM game_details d,json_each(d.tags) j GROUP BY j.value COLLATE NOCASE
                ORDER BY games DESC,j.value COLLATE NOCASE LIMIT 100""")
            ]
            undo = [
                dict(row)
                for row in connection.execute("""
                SELECT id,label,created_at FROM library_undo
                ORDER BY created_at DESC,rowid DESC LIMIT 10""")
            ]
        return {**totals, "folders": folders, "tags": tags, "undo": undo}

    def undo_organization(self, identifier: str) -> dict[str, Any]:
        with self.database._connect() as connection:
            row = connection.execute(
                "SELECT length(CAST(edits AS BLOB)) FROM library_undo WHERE id=?", (identifier,)
            ).fetchone()
            if row is None:
                raise ValueError("This undo record has expired or was already used.")
            if row[0] > 4 * 1024 * 1024:
                raise ValueError("Undo record exceeds the 4 MB limit.")
            edits = json.loads(
                connection.execute(
                    "SELECT edits FROM library_undo WHERE id=?", (identifier,)
                ).fetchone()[0]
            )
            if not isinstance(edits, list) or not 1 <= len(edits) <= 500:
                raise ValueError("Invalid undo record.")
            ids = []
            for edit in edits:
                if not isinstance(edit, dict) or type(edit.get("id")) is not int:
                    raise ValueError("Invalid undo game.")
                before, after = edit.get("before"), edit.get("after")
                if (
                    not isinstance(before, dict)
                    or not isinstance(after, dict)
                    or not before
                    or set(before) != set(after)
                    or set(before) - ORGANIZATION_FIELDS
                ):
                    raise ValueError("Invalid undo fields.")
                for state in (before, after):
                    for field, value in state.items():
                        if field == "favorite":
                            if value not in (0, 1):
                                raise ValueError("Invalid undo favorite.")
                        elif (
                            not isinstance(value, str)
                            or len(value) > {"folder": 80, "notes": 10000, "tags": 10000}[field]
                        ):
                            raise ValueError("Invalid undo value.")
                        elif field == "tags":
                            clean_tags(json.loads(value))
                current = connection.execute(
                    "SELECT * FROM game_details WHERE game_id=?", (edit["id"],)
                ).fetchone()
                if current is None or any(current[key] != value for key, value in after.items()):
                    raise ValueError(
                        "A game was changed again after this edit. "
                        "Undo the newer edit first; nothing was changed."
                    )
                connection.execute(
                    f"UPDATE game_details SET {','.join(f'{key}=?' for key in before)} "
                    "WHERE game_id=?",
                    [*before.values(), edit["id"]],
                )
                ids.append(edit["id"])
            connection.execute("DELETE FROM library_undo WHERE id=?", (identifier,))
        return {"restored": len(ids), "ids": ids}

    @staticmethod
    def _ids(value: Any) -> list[int]:
        if not isinstance(value, list) or not 1 <= len(value) <= 500:
            raise ValueError("Select between 1 and 500 games.")
        if any(type(item) is not int or item <= 0 for item in value):
            raise ValueError("Game IDs must be positive integers.")
        return list(dict.fromkeys(value))

    def export(self, ids: Any) -> dict[str, str]:
        identifiers = self._ids(ids)
        games = []
        size = 0
        with self.database._connect() as connection:
            for identifier in identifiers:
                row = connection.execute(
                    "SELECT pgn FROM games WHERE id=?", (identifier,)
                ).fetchone()
                if row is None:
                    raise ValueError("A selected game no longer exists.")
                size += len(row[0].encode())
                if size > 16 * 1024 * 1024:
                    raise ValueError("Export exceeds 16 MB. Select fewer games.")
                games.append(str(row[0]))
        return {"pgn": "\n\n".join(games) + "\n"}

    def edit_headers(self, payload: dict[str, Any]) -> dict[str, Any]:
        changes = payload.get("headers")
        if not isinstance(changes, dict) or set(changes) - HEADERS.keys():
            raise ValueError("Unsupported PGN header changes.")
        if any(
            not isinstance(v, str) or len(v) > 300 or any(c in v for c in '\r\n\x00"\\')
            for v in changes.values()
        ):
            raise ValueError(
                "Headers must be at most 300 characters without "
                "line breaks, quotes, or backslashes."
            )
        for key in ("WhiteElo", "BlackElo"):
            if changes.get(key) and not re.fullmatch(r"[0-9]{1,4}|\?", changes[key]):
                raise ValueError("Ratings must be numeric or unknown (?).")
        if "Date" in changes and not re.fullmatch(
            r"[0-9?]{4}\.[0-9?]{2}\.[0-9?]{2}", changes["Date"]
        ):
            raise ValueError("Use a PGN date such as 2026.09.02 or ????.??.??.")
        if "Date" in changes:
            year, month, day = changes["Date"].split(".")
            if (month.isdigit() and not 1 <= int(month) <= 12) or (
                day.isdigit() and not 1 <= int(day) <= 31
            ):
                raise ValueError("PGN date has an invalid month or day.")
            if all(part.isdigit() for part in (year, month, day)):
                try:
                    date(int(year), int(month), int(day))
                except ValueError as exc:
                    raise ValueError("PGN date is not a real calendar date.") from exc
        if changes.get("ECO") and not re.fullmatch(r"[A-E][0-9]{2}", changes["ECO"]):
            raise ValueError("ECO headers must use a code from A00 through E99.")
        if "Result" in changes and changes["Result"] not in {"1-0", "0-1", "1/2-1/2", "*"}:
            raise ValueError("Invalid result.")
        with self.database._connect() as connection:
            row = connection.execute(
                "SELECT pgn FROM games WHERE id=?", (int(payload.get("id", 0)),)
            ).fetchone()
            if row is None:
                raise ValueError("Game no longer exists.")
            if hashlib.sha256(row[0].encode()).hexdigest() != payload.get("revision"):
                raise ValueError(
                    "This game changed since it was opened. Refresh its preview before saving."
                )
            game = chess.pgn.read_game(io.StringIO(row[0]))
            if game is None or game.errors:
                raise ValueError("Stored game has invalid PGN.")
            game.headers.update(changes)
            values: list[Any] = [
                self.database._integer_header(game.headers, header)
                if header.endswith("Elo")
                else str(game.headers.get(header, ""))
                for header in HEADERS
            ]
            values.extend(
                [
                    self.database._year(game.headers),
                    str(game),
                    self.database._fingerprint(
                        game, [move.uci() for move in game.mainline_moves()]
                    ),
                    int(payload["id"]),
                ]
            )
            try:
                connection.execute(
                    f"""UPDATE games SET {",".join(f"{column}=?" for column in HEADERS.values())},
                    year=?,pgn=?,fingerprint=? WHERE id=?""",
                    values,
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(
                    "These headers would duplicate an existing game. No changes were saved."
                ) from exc
        return {
            "saved": True,
            "headers": dict(game.headers),
            "pgn": str(game),
            "revision": hashlib.sha256(str(game).encode()).hexdigest(),
            "metadata": dict(zip(HEADERS.values(), values[: len(HEADERS)], strict=True)),
        }

    def views(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = payload.get("action", "list")
        with self.database._connect() as connection:
            if action in {"save", "delete"}:
                name = str(payload.get("name", "")).strip()
                if not 1 <= len(name) <= 60:
                    raise ValueError("Search names must be 1-60 characters.")
                if action == "delete":
                    connection.execute("DELETE FROM library_views WHERE name=?", (name,))
                else:
                    filters = payload.get("filters", {})
                    if not isinstance(filters, dict) or len(json.dumps(filters)) > 8000:
                        raise ValueError("Saved search is too large or invalid.")
                    where_clause(filters)
                    count = connection.execute("SELECT COUNT(*) FROM library_views").fetchone()[0]
                    if (
                        count >= 25
                        and not connection.execute(
                            "SELECT 1 FROM library_views WHERE name=?", (name,)
                        ).fetchone()
                    ):
                        raise ValueError(
                            "Remove an older saved search before adding another (limit 25)."
                        )
                    connection.execute(
                        "INSERT OR REPLACE INTO library_views VALUES(?,?)",
                        (name, json.dumps(filters)),
                    )
            elif action != "list":
                raise ValueError("Unknown saved-search action.")
            rows = connection.execute(
                "SELECT * FROM library_views ORDER BY name COLLATE NOCASE"
            ).fetchall()
        return {
            "views": [{"name": row["name"], "filters": json.loads(row["filters"])} for row in rows]
        }

    def report(self, payload: dict[str, Any]) -> dict[str, Any]:
        filters = payload.get("filters", {})
        if not isinstance(filters, dict):
            raise ValueError("Report filters must be an object.")
        where, values = where_clause(filters)
        with self.database._connect() as connection:
            overall = dict(
                connection.execute(
                    f"""
                SELECT COUNT(*) AS games, SUM(g.result='1-0') AS white_wins,
                    SUM(g.result='0-1') AS black_wins, SUM(g.result='1/2-1/2') AS draws,
                    SUM(g.result='*') AS unfinished,
                    MIN(g.year) AS first_year, MAX(g.year) AS last_year
                FROM games g JOIN game_details d ON d.game_id=g.id WHERE {where}
            """,
                    values,
                ).fetchone()
            )
            openings = [
                dict(row)
                for row in connection.execute(
                    f"""
                SELECT COALESCE(NULLIF(g.eco,''),'Unclassified') AS eco, COUNT(*) AS games,
                    SUM(g.result='1-0') AS white_wins, SUM(g.result='0-1') AS black_wins,
                    SUM(g.result='1/2-1/2') AS draws
                FROM games g JOIN game_details d ON d.game_id=g.id WHERE {where}
                GROUP BY eco ORDER BY games DESC,eco LIMIT 30
            """,
                    values,
                )
            ]
            years = [
                dict(row)
                for row in connection.execute(
                    f"""
                SELECT g.year, COUNT(*) AS games FROM games g
                JOIN game_details d ON d.game_id=g.id WHERE {where} GROUP BY g.year ORDER BY g.year
            """,
                    values,
                )
            ]
            player = str(payload.get("player", "")).strip()[:200]
            opponent = str(payload.get("opponent", "")).strip()[:200]
            dossier: list[dict[str, Any]] = []
            if player:
                for side, other, win, loss in (
                    ("white", "black", "1-0", "0-1"),
                    ("black", "white", "0-1", "1-0"),
                ):
                    against = f"AND g.{other}=? COLLATE NOCASE" if opponent else ""
                    row = connection.execute(
                        f"""
                        SELECT COUNT(*) AS games,
                            SUM(g.result=?) AS wins, SUM(g.result=?) AS losses,
                            SUM(g.result='1/2-1/2') AS draws, SUM(g.result='*') AS unfinished,
                            MAX(g.{side}_elo) AS peak_rating
                        FROM games g JOIN game_details d ON d.game_id=g.id
                        WHERE {where} AND g.{side}=? COLLATE NOCASE {against}
                    """,
                        [win, loss, *values, player, *([opponent] if opponent else [])],
                    ).fetchone()
                    dossier.append({"side": side, **dict(row)})
        return {
            "overall": overall,
            "openings": openings,
            "years": years,
            "player": player,
            "opponent": opponent,
            "dossier": dossier,
        }
