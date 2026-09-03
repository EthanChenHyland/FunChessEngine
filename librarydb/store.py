"""SQLite-backed reference-game and position index for large local PGN collections."""

from __future__ import annotations

import hashlib
import io
import os
import re
import sqlite3
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import chess
import chess.pgn

from librarydb.catalog import ensure_catalog, line_key
from librarydb.connections import DATABASE_LOCK


def default_data_dir() -> Path:
    override = os.environ.get("FUNCHESS_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "FunChessEngine"
    if os.name == "nt":
        root = Path(os.environ.get("APPDATA", str(Path.home())))
        return root / "FunChessEngine"
    root = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return root / "FunChessEngine"


def default_database_path() -> Path:
    return default_data_dir() / "library.sqlite3"


def fen_key(fen: str) -> str:
    fields = str(fen).split()
    return " ".join(fields[:4]) if len(fields) >= 4 else str(fen).strip()


def _passed_pawns(board: chess.Board, color: chess.Color) -> list[int]:
    enemy = board.pieces(chess.PAWN, not color)
    result: list[int] = []
    for square in board.pieces(chess.PAWN, color):
        own_file = chess.square_file(square)
        own_rank = chess.square_rank(square)
        blocked = False
        for enemy_square in enemy:
            if abs(chess.square_file(enemy_square) - own_file) > 1:
                continue
            enemy_rank = chess.square_rank(enemy_square)
            if (color == chess.WHITE and enemy_rank > own_rank) or (
                color == chess.BLACK and enemy_rank < own_rank
            ):
                blocked = True
                break
        if not blocked:
            result.append(square)
    return result


def structure_tags(board: chess.Board) -> tuple[str, ...]:
    tags: set[str] = set()
    white_pawns = {chess.square_name(square) for square in board.pieces(chess.PAWN, chess.WHITE)}
    black_pawns = {chess.square_name(square) for square in board.pieces(chess.PAWN, chess.BLACK)}

    def isolated_d(color: chess.Color) -> bool:
        pawns = board.pieces(chess.PAWN, color)
        d_pawns = [square for square in pawns if chess.square_file(square) == 3]
        adjacent = {
            chess.square_file(square) for square in pawns if chess.square_file(square) in {2, 4}
        }
        return bool(d_pawns and not adjacent)

    if isolated_d(chess.WHITE):
        tags.update({"IQP", "white IQP"})
    if isolated_d(chess.BLACK):
        tags.update({"IQP", "black IQP"})
    if {"c4", "d4"}.issubset(white_pawns) and not ({"b4", "e4"} & white_pawns):
        tags.update({"hanging pawns", "white hanging pawns"})
    if {"c5", "d5"}.issubset(black_pawns) and not ({"b5", "e5"} & black_pawns):
        tags.update({"hanging pawns", "black hanging pawns"})
    if {"c4", "e4"}.issubset(white_pawns):
        tags.add("Maroczy bind")
    if {"c4", "d4", "e3"}.issubset(white_pawns) and {"c6", "d5", "e6"}.issubset(black_pawns):
        tags.add("Carlsbad structure")

    white_king = board.king(chess.WHITE)
    black_king = board.king(chess.BLACK)
    if white_king is not None and black_king is not None:
        white_file = chess.square_file(white_king)
        black_file = chess.square_file(black_king)
        if (white_file <= 2 and black_file >= 5) or (white_file >= 5 and black_file <= 2):
            tags.add("opposite-side castling")

    queens = board.pieces(chess.QUEEN, chess.WHITE) | board.pieces(chess.QUEEN, chess.BLACK)
    rooks = board.pieces(chess.ROOK, chess.WHITE) | board.pieces(chess.ROOK, chess.BLACK)
    bishops = board.pieces(chess.BISHOP, chess.WHITE) | board.pieces(chess.BISHOP, chess.BLACK)
    knights = board.pieces(chess.KNIGHT, chess.WHITE) | board.pieces(chess.KNIGHT, chess.BLACK)
    if not queens and rooks and not bishops and not knights:
        tags.add("rook endgame")
    if not queens and not rooks and bishops and knights:
        tags.add("bishop vs knight")
    if any(
        chess.square_rank(square) == (5 if color == chess.WHITE else 2)
        for color in (chess.WHITE, chess.BLACK)
        for square in _passed_pawns(board, color)
    ):
        tags.add("passed pawn on sixth rank")
    return tuple(sorted(tags))


def parse_library_query(query: str) -> dict[str, Any]:
    """Parse a small deterministic chess-search language into indexed filters."""

    text = " ".join(str(query).strip().lower().split())
    filters: dict[str, Any] = {}
    structures = {
        "isolated queen pawn": "IQP",
        "iqp": "IQP",
        "carlsbad": "Carlsbad structure",
        "hanging pawns": "hanging pawns",
        "maroczy": "Maroczy bind",
        "opposite-side castling": "opposite-side castling",
        "opposite side castling": "opposite-side castling",
        "rook endings": "rook endgame",
        "rook endgames": "rook endgame",
        "rook ending": "rook endgame",
        "bishop vs knight": "bishop vs knight",
        "bishop versus knight": "bishop vs knight",
        "passed pawn on sixth": "passed pawn on sixth rank",
    }
    for phrase, tag in structures.items():
        if phrase in text:
            filters["structure"] = tag
            break
    openings = {
        "sicilian": "Sicilian",
        "french defense": "French",
        "french defence": "French",
        "caro-kann": "Caro-Kann",
        "ruy lopez": "Ruy Lopez",
        "queen's gambit": "Queen's Gambit",
        "queens gambit": "Queen's Gambit",
        "king's indian": "King's Indian",
        "kings indian": "King's Indian",
        "english opening": "English",
    }
    for phrase, opening in openings.items():
        if phrase in text:
            filters["opening"] = opening
            break
    if "white won" in text or "white wins" in text:
        filters["result"] = "1-0"
    elif "black won" in text or "black wins" in text:
        filters["result"] = "0-1"
    elif "draw" in text:
        filters["result"] = "1/2-1/2"
    before_move = re.search(r"before move\s+(\d{1,3})", text)
    if before_move:
        filters["max_ply"] = max(1, min(2_000, int(before_move.group(1)) * 2))
    since = re.search(r"since\s+(\d{4})", text)
    if since:
        filters["year_from"] = int(since.group(1))
    before_year = re.search(r"before\s+(\d{4})", text)
    if before_year:
        filters["year_to"] = int(before_year.group(1)) - 1
    quoted_player = re.search(r"player\s+[\"']([^\"']+)[\"']", text)
    if quoted_player:
        filters["player"] = quoted_player.group(1).strip()
    return filters


class LibraryDatabase:
    """Small connection-per-operation SQLite index safe for threaded local HTTP use."""

    def __init__(self, path: str | os.PathLike[str] | None = None) -> None:
        self.path = Path(path) if path is not None else default_database_path()
        self.path = self.path.expanduser().resolve()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        with DATABASE_LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=15.0)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            self._ensure_schema(connection)
            try:
                with connection:
                    yield connection
            finally:
                connection.close()

    @staticmethod
    def _ensure_schema(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY,
                fingerprint TEXT NOT NULL UNIQUE,
                source TEXT NOT NULL,
                event TEXT,
                site TEXT,
                game_date TEXT,
                year INTEGER,
                round TEXT,
                white TEXT,
                black TEXT,
                white_elo INTEGER,
                black_elo INTEGER,
                result TEXT,
                eco TEXT,
                opening TEXT,
                initial_fen TEXT NOT NULL,
                variant TEXT NOT NULL,
                pgn TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS positions (
                game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                ply INTEGER NOT NULL,
                fen_key TEXT NOT NULL,
                full_fen TEXT NOT NULL,
                turn TEXT NOT NULL,
                move_uci TEXT,
                move_san TEXT,
                PRIMARY KEY (game_id, ply)
            );
            CREATE TABLE IF NOT EXISTS position_tags (
                game_id INTEGER NOT NULL,
                ply INTEGER NOT NULL,
                tag TEXT NOT NULL,
                FOREIGN KEY (game_id, ply) REFERENCES positions(game_id, ply) ON DELETE CASCADE,
                PRIMARY KEY (game_id, ply, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_games_white ON games(white);
            CREATE INDEX IF NOT EXISTS idx_games_black ON games(black);
            CREATE INDEX IF NOT EXISTS idx_games_year ON games(year);
            CREATE INDEX IF NOT EXISTS idx_games_result ON games(result);
            CREATE INDEX IF NOT EXISTS idx_games_eco ON games(eco);
            CREATE INDEX IF NOT EXISTS idx_positions_fen ON positions(fen_key);
            CREATE INDEX IF NOT EXISTS idx_positions_move ON positions(move_uci);
            CREATE INDEX IF NOT EXISTS idx_tags_tag ON position_tags(tag);
            """
        )

        ensure_catalog(connection)

    @staticmethod
    def _integer_header(headers: chess.pgn.Headers, name: str) -> int | None:
        try:
            value = int(str(headers.get(name, "")).strip())
        except ValueError:
            return None
        return value if 0 < value < 10_000 else None

    @staticmethod
    def _year(headers: chess.pgn.Headers) -> int | None:
        match = re.match(r"(\d{4})", str(headers.get("Date", "")))
        return int(match.group(1)) if match else None

    @staticmethod
    def _fingerprint(game: chess.pgn.Game, moves: list[str]) -> str:
        headers = game.headers
        identity = "\n".join(
            [
                str(game.board().fen()),
                " ".join(moves),
                str(headers.get("Event", "")),
                str(headers.get("Date", "")),
                str(headers.get("White", "")),
                str(headers.get("Black", "")),
                str(headers.get("Result", "*")),
            ]
        )
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    def import_pgn_text(
        self,
        text: str,
        *,
        source: str = "reference",
        max_games: int = 10_000,
    ) -> dict[str, int]:
        if not str(text).strip():
            raise ValueError("PGN collection is empty.")
        limit = max(1, min(100_000, int(max_games)))
        stream = io.StringIO(str(text))
        imported = 0
        duplicates = 0
        indexed_positions = 0
        parsed = 0
        with self._connect() as connection:
            while parsed < limit:
                try:
                    game = chess.pgn.read_game(stream)
                except (ValueError, UnicodeError) as exc:
                    raise ValueError("Could not parse this reference PGN collection.") from exc
                if game is None:
                    break
                parsed += 1
                if game.errors:
                    raise ValueError(f"Reference PGN game {parsed} contains invalid notation.")
                moves = [move.uci() for move in game.mainline_moves()]
                if len(moves) > 1_000:
                    raise ValueError(f"Reference PGN game {parsed} contains too many moves.")
                headers = game.headers
                fingerprint = self._fingerprint(game, moves)
                cursor = connection.execute(
                    """
                    INSERT OR IGNORE INTO games (
                        fingerprint, source, event, site, game_date, year, round, white, black,
                        white_elo, black_elo, result, eco, opening, initial_fen, variant, pgn
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        fingerprint,
                        str(source)[:200],
                        str(headers.get("Event", ""))[:300],
                        str(headers.get("Site", ""))[:300],
                        str(headers.get("Date", ""))[:20],
                        self._year(headers),
                        str(headers.get("Round", ""))[:40],
                        str(headers.get("White", ""))[:200],
                        str(headers.get("Black", ""))[:200],
                        self._integer_header(headers, "WhiteElo"),
                        self._integer_header(headers, "BlackElo"),
                        str(headers.get("Result", "*"))[:16],
                        str(headers.get("ECO", ""))[:16],
                        str(headers.get("Opening", ""))[:300],
                        game.board().fen(),
                        "chess960" if game.board().chess960 else "standard",
                        str(game),
                    ),
                )
                if cursor.rowcount == 0:
                    duplicates += 1
                    continue
                assert cursor.lastrowid is not None
                game_id = cursor.lastrowid
                connection.execute(
                    "INSERT INTO game_details(game_id,plies,line_key) VALUES(?,?,?)",
                    (game_id, len(moves), line_key(game.board().fen(), " ".join(moves))),
                )
                board = game.board()
                for ply, move in enumerate(game.mainline_moves()):
                    before = board.fen()
                    san = board.san(move)
                    turn = "w" if board.turn == chess.WHITE else "b"
                    connection.execute(
                        """
                        INSERT INTO positions
                            (game_id, ply, fen_key, full_fen, turn, move_uci, move_san)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (game_id, ply, fen_key(before), before, turn, move.uci(), san),
                    )
                    for tag in structure_tags(board):
                        connection.execute(
                            "INSERT INTO position_tags (game_id, ply, tag) VALUES (?, ?, ?)",
                            (game_id, ply, tag),
                        )
                    indexed_positions += 1
                    board.push(move)
                final_fen = board.fen()
                final_ply = len(moves)
                connection.execute(
                    """
                    INSERT INTO positions
                        (game_id, ply, fen_key, full_fen, turn, move_uci, move_san)
                    VALUES (?, ?, ?, ?, ?, NULL, NULL)
                    """,
                    (
                        game_id,
                        final_ply,
                        fen_key(final_fen),
                        final_fen,
                        "w" if board.turn == chess.WHITE else "b",
                    ),
                )
                for tag in structure_tags(board):
                    connection.execute(
                        "INSERT INTO position_tags (game_id, ply, tag) VALUES (?, ?, ?)",
                        (game_id, final_ply, tag),
                    )
                indexed_positions += 1
                imported += 1
            if parsed == limit and chess.pgn.read_game(stream) is not None:
                raise ValueError(f"Reference PGN exceeds the {limit}-game import limit.")
        return {
            "parsed": parsed,
            "imported": imported,
            "duplicates": duplicates,
            "positions": indexed_positions,
        }

    def stats(self) -> dict[str, int | str]:
        with self._connect() as connection:
            games = int(connection.execute("SELECT COUNT(*) FROM games").fetchone()[0])
            positions = int(connection.execute("SELECT COUNT(*) FROM positions").fetchone()[0])
        return {"games": games, "positions": positions, "path": str(self.path)}

    def distinct_fens(self, limit: int = 100_000) -> list[str]:
        row_limit = max(1, min(100_000, int(limit)))
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT MIN(full_fen) AS full_fen
                FROM positions
                GROUP BY fen_key
                ORDER BY MIN(game_id), MIN(ply)
                LIMIT ?
                """,
                (row_limit,),
            ).fetchall()
        return [str(row["full_fen"]) for row in rows if row["full_fen"]]

    @staticmethod
    def _filter_sql(filters: dict[str, Any]) -> tuple[list[str], list[Any], bool, bool]:
        clauses: list[str] = []
        values: list[Any] = []
        need_positions = bool(
            filters.get("fen") or filters.get("fen_key") or filters.get("max_ply") is not None
        )
        need_tags = bool(filters.get("structure"))
        player = str(filters.get("player", "")).strip()
        if player:
            clauses.append("(LOWER(g.white) LIKE ? OR LOWER(g.black) LIKE ?)")
            pattern = f"%{player.lower()}%"
            values.extend([pattern, pattern])
        opening = str(filters.get("opening", "")).strip()
        if opening:
            clauses.append("LOWER(COALESCE(g.opening, '')) LIKE ?")
            values.append(f"%{opening.lower()}%")
        eco = str(filters.get("eco", "")).strip()
        if eco:
            clauses.append("UPPER(COALESCE(g.eco, '')) LIKE ?")
            values.append(f"{eco.upper()}%")
        result = str(filters.get("result", "")).strip()
        if result in {"1-0", "0-1", "1/2-1/2", "*"}:
            clauses.append("g.result = ?")
            values.append(result)
        for key, operator in (("year_from", ">="), ("year_to", "<=")):
            if filters.get(key) is not None:
                clauses.append(f"g.year {operator} ?")
                values.append(int(filters[key]))
        if filters.get("min_elo") is not None:
            clauses.append("MAX(COALESCE(g.white_elo, 0), COALESCE(g.black_elo, 0)) >= ?")
            values.append(max(0, int(filters["min_elo"])))
        if filters.get("fen") or filters.get("fen_key"):
            clauses.append("p.fen_key = ?")
            values.append(fen_key(str(filters.get("fen") or filters.get("fen_key"))))
        if filters.get("max_ply") is not None:
            clauses.append("p.ply <= ?")
            values.append(max(0, min(2_000, int(filters["max_ply"]))))
        if need_tags:
            clauses.append("LOWER(t.tag) = LOWER(?)")
            values.append(str(filters["structure"]))
        return clauses, values, need_positions, need_tags

    def search_games(
        self,
        filters: dict[str, Any] | None = None,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        selected = dict(filters or {})
        clauses, values, need_positions, need_tags = self._filter_sql(selected)
        joins: list[str] = []
        if need_positions or need_tags:
            joins.append("JOIN positions p ON p.game_id = g.id")
        if need_tags:
            joins.append("JOIN position_tags t ON t.game_id = p.game_id AND t.ply = p.ply")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        count_sql = f"SELECT COUNT(DISTINCT g.id) FROM games g {' '.join(joins)} {where}"
        query_sql = f"""
            SELECT DISTINCT g.id, g.source, g.event, g.game_date, g.year, g.white, g.black,
                g.white_elo, g.black_elo, g.result, g.eco, g.opening, g.variant
            FROM games g {" ".join(joins)} {where}
            ORDER BY COALESCE(g.year, 0) DESC, g.id DESC
            LIMIT ? OFFSET ?
        """
        row_limit = max(1, min(500, int(limit)))
        row_offset = max(0, int(offset))
        with self._connect() as connection:
            total = int(connection.execute(count_sql, values).fetchone()[0])
            rows = connection.execute(query_sql, [*values, row_limit, row_offset]).fetchall()
        return {"total": total, "games": [dict(row) for row in rows]}

    def game(self, game_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM games WHERE id = ?", (int(game_id),)).fetchone()
        return dict(row) if row is not None else None

    def opening_moves(
        self,
        fen: str,
        filters: dict[str, Any] | None = None,
        *,
        limit: int = 20,
    ) -> dict[str, Any]:
        selected = dict(filters or {})
        selected.pop("fen", None)
        selected.pop("fen_key", None)
        clauses, values, _, need_tags = self._filter_sql(selected)
        clauses.insert(0, "p.fen_key = ?")
        values.insert(0, fen_key(fen))
        clauses.append("p.move_uci IS NOT NULL")
        joins = ["JOIN games g ON g.id = p.game_id"]
        if need_tags:
            joins.append("JOIN position_tags t ON t.game_id = p.game_id AND t.ply = p.ply")
        sql = f"""
            WITH candidates AS (
                SELECT DISTINCT g.id, g.result, g.white_elo, g.black_elo,
                    p.turn, p.move_uci, p.move_san
                FROM positions p {" ".join(joins)}
                WHERE {" AND ".join(clauses)}
            )
            SELECT p.move_uci, MAX(p.move_san) AS move_san, COUNT(*) AS games,
                SUM(CASE
                    WHEN (p.turn = 'w' AND p.result = '1-0') OR
                         (p.turn = 'b' AND p.result = '0-1') THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN p.result = '1/2-1/2' THEN 1 ELSE 0 END) AS draws,
                SUM(CASE
                    WHEN (p.turn = 'w' AND p.result = '0-1') OR
                         (p.turn = 'b' AND p.result = '1-0') THEN 1 ELSE 0 END) AS losses,
                ROUND(AVG(CASE WHEN p.turn = 'w' THEN p.white_elo ELSE p.black_elo END)) AS avg_elo
            FROM candidates p
            GROUP BY p.move_uci
            ORDER BY games DESC, wins DESC
            LIMIT ?
        """
        row_limit = max(1, min(100, int(limit)))
        with self._connect() as connection:
            rows = connection.execute(sql, [*values, row_limit]).fetchall()
        return {"fen_key": fen_key(fen), "moves": [dict(row) for row in rows]}
