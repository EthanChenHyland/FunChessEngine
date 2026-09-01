"""Dependency-free local web UI for FunChessEngine.

Run with::

    python -m gui.server

The GUI is local-only.  It is deliberately kept below ``gui/`` so the
engine packager, which includes root-level Python files plus optional
weights, never puts the UI into ``engine-package.zip``.
"""

from __future__ import annotations

import argparse
import errno
import io
import json
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import chess
import chess.pgn

import agent

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ROOT = Path(str(sys._MEIPASS)) / "gui"
else:
    ROOT = Path(__file__).resolve().parent
DEFAULT_CLOCK_MS = 120_000
DEFAULT_INCREMENT_MS = 500


class GameSession:
    """Owns one local board and the clocks used by the browser UI."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.board = chess.Board()
        self.initial_fen = chess.STARTING_FEN
        self.white_ms = DEFAULT_CLOCK_MS
        self.black_ms = DEFAULT_CLOCK_MS
        self.base_clock_ms = DEFAULT_CLOCK_MS
        self.increment_ms = DEFAULT_INCREMENT_MS
        self.last_move: chess.Move | None = None
        self.last_engine_ms = 0
        self.last_engine_nodes = 0
        self.last_engine_depth: int | None = None
        self.last_engine_score: int | None = None
        self.last_engine_pv: tuple[str, ...] = ()
        self.last_engine_researches = 0
        self.history: list[tuple[int, int]] = []
        self.paused = False
        self.manual_result: str | None = None
        self.manual_termination: str | None = None
        self.pgn_headers: dict[str, str] = {}
        self.turn_started_ns = time.monotonic_ns()

    def reset(
        self,
        fen: str = chess.STARTING_FEN,
        clock_ms: int = DEFAULT_CLOCK_MS,
        increment_ms: int = DEFAULT_INCREMENT_MS,
    ) -> None:
        board = chess.Board(fen)
        if not board.is_valid():
            raise ValueError(
                "Invalid chess position. Check that both kings exist, pawns are off the back "
                "ranks, kings are not adjacent, and castling/en-passant rights match the board."
            )
        with self.lock:
            agent.reset_game_state()
            self.board = board
            self.initial_fen = fen
            self.white_ms = max(1, int(clock_ms))
            self.black_ms = max(1, int(clock_ms))
            self.base_clock_ms = max(1, int(clock_ms))
            self.increment_ms = max(0, int(increment_ms))
            self.last_move = None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.history.clear()
            self.paused = False
            self.manual_result = None
            self.manual_termination = None
            self.pgn_headers = {}
            self.turn_started_ns = time.monotonic_ns()

    def _current_clocks(self, now_ns: int | None = None) -> tuple[int, int]:
        """Return live clock values without mutating the stored turn baseline."""

        white_ms = self.white_ms
        black_ms = self.black_ms
        if (
            self.paused
            or self.manual_result is not None
            or self.board.is_game_over(claim_draw=True)
        ):
            return max(0, white_ms), max(0, black_ms)
        now = time.monotonic_ns() if now_ns is None else now_ns
        elapsed_ms = max(0, (now - self.turn_started_ns) // 1_000_000)
        if self.board.turn == chess.WHITE:
            white_ms -= elapsed_ms
        else:
            black_ms -= elapsed_ms
        return max(0, int(white_ms)), max(0, int(black_ms))

    def _commit_clock(self) -> None:
        now = time.monotonic_ns()
        self.white_ms, self.black_ms = self._current_clocks(now)
        self.turn_started_ns = now

    def _clock_flag(self, white_ms: int, black_ms: int) -> chess.Color | None:
        if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
            return None
        if self.board.turn == chess.WHITE and white_ms <= 0:
            return chess.WHITE
        if self.board.turn == chess.BLACK and black_ms <= 0:
            return chess.BLACK
        return None

    def _moves_uci(self) -> list[str]:
        return [move.uci() for move in self.board.move_stack]

    @staticmethod
    def _captures(board: chess.Board) -> tuple[list[str], list[str]]:
        replay = chess.Board(board.root().fen())
        by_white: list[str] = []
        by_black: list[str] = []
        for move in board.move_stack:
            captured: chess.Piece | None = None
            if replay.is_capture(move):
                if replay.is_en_passant(move):
                    offset = -8 if replay.turn == chess.WHITE else 8
                    captured = replay.piece_at(move.to_square + offset)
                else:
                    captured = replay.piece_at(move.to_square)
            if captured is not None:
                (by_white if replay.turn == chess.WHITE else by_black).append(captured.symbol())
            replay.push(move)
        return by_white, by_black

    @staticmethod
    def _material_balance(board: chess.Board) -> int:
        values = {
            chess.PAWN: 1,
            chess.KNIGHT: 3,
            chess.BISHOP: 3,
            chess.ROOK: 5,
            chess.QUEEN: 9,
        }
        white = sum(
            len(board.pieces(piece, chess.WHITE)) * value for piece, value in values.items()
        )
        black = sum(
            len(board.pieces(piece, chess.BLACK)) * value for piece, value in values.items()
        )
        return white - black

    def load_snapshot(self, payload: dict[str, Any]) -> None:
        """Restore a game exported by the local Engine Lab."""

        initial_fen = str(payload.get("initial_fen", chess.STARTING_FEN))
        moves_raw = payload.get("moves", [])
        history_raw = payload.get("clock_history", [])
        if not isinstance(moves_raw, list) or len(moves_raw) > 1_000:
            raise ValueError("Saved game contains an invalid move list.")
        if not isinstance(history_raw, list) or len(history_raw) > 1_000:
            raise ValueError("Saved game contains invalid clock history.")

        board = chess.Board(initial_fen)
        if not board.is_valid():
            raise ValueError("Saved game starts from an invalid chess position.")
        moves: list[chess.Move] = []
        for raw in moves_raw:
            try:
                move = chess.Move.from_uci(str(raw))
            except ValueError as exc:
                raise ValueError("Saved game contains a malformed move.") from exc
            if move not in board.legal_moves:
                raise ValueError(f"Saved game contains illegal move {move.uci()}.")
            board.push(move)
            moves.append(move)

        history: list[tuple[int, int]] = []
        for item in history_raw:
            if not isinstance(item, list) or len(item) != 2:
                raise ValueError("Saved game contains invalid clock history.")
            history.append((max(0, int(item[0])), max(0, int(item[1]))))
        if history and len(history) != len(moves):
            raise ValueError("Saved game clock history does not match its moves.")

        with self.lock:
            agent.reset_game_state()
            self.board = board
            self.initial_fen = initial_fen
            self.white_ms = max(0, int(payload.get("white_ms", DEFAULT_CLOCK_MS)))
            self.black_ms = max(0, int(payload.get("black_ms", DEFAULT_CLOCK_MS)))
            self.base_clock_ms = max(
                1, int(payload.get("base_clock_ms", max(self.white_ms, self.black_ms, 1)))
            )
            self.increment_ms = max(0, int(payload.get("increment_ms", DEFAULT_INCREMENT_MS)))
            self.last_move = moves[-1] if moves else None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.history = history if history else [
                (self.white_ms, self.black_ms) for _ in moves
            ]
            self.paused = bool(payload.get("paused", False))
            manual_result = payload.get("manual_result")
            manual_termination = payload.get("manual_termination")
            self.manual_result = (
                str(manual_result)
                if manual_result in {"1-0", "0-1", "1/2-1/2"}
                else None
            )
            self.manual_termination = (
                str(manual_termination) if self.manual_result is not None else None
            )
            headers_raw = payload.get("pgn_headers", {})
            self.pgn_headers = (
                {
                    str(key): str(value)
                    for key, value in headers_raw.items()
                    if isinstance(key, str) and isinstance(value, str)
                }
                if isinstance(headers_raw, dict)
                else {}
            )
            self.turn_started_ns = time.monotonic_ns()

    @staticmethod
    def _white_eval(board: chess.Board) -> int:
        score = agent.evaluate(board)
        return score if board.turn == chess.WHITE else -score

    def load_pgn(self, text: str) -> None:
        """Load the main line of one PGN as a paused/reviewable game."""

        if not text.strip():
            raise ValueError("PGN file is empty.")
        if len(text.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("PGN file is too large for the local review workspace.")

        try:
            game = chess.pgn.read_game(io.StringIO(text))
        except (ValueError, UnicodeError) as exc:
            raise ValueError("Could not parse this PGN.") from exc
        if game is None:
            raise ValueError("No chess game was found in this PGN.")

        board = game.board()
        if not board.is_valid():
            raise ValueError("PGN starts from an invalid chess position.")
        initial_fen = board.fen()
        moves: list[chess.Move] = []
        for move in game.mainline_moves():
            if move not in board.legal_moves:
                raise ValueError(f"PGN contains illegal move {move.uci()}.")
            board.push(move)
            moves.append(move)
            if len(moves) > 1_000:
                raise ValueError("PGN contains too many moves for the local review workspace.")

        headers = {
            str(key): str(value)
            for key, value in game.headers.items()
            if str(value) not in {"?", ""}
        }
        result = headers.get("Result")
        with self.lock:
            agent.reset_game_state()
            self.board = board
            self.initial_fen = initial_fen
            self.white_ms = self.base_clock_ms
            self.black_ms = self.base_clock_ms
            self.last_move = moves[-1] if moves else None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.last_engine_score = None
            self.last_engine_pv = ()
            self.last_engine_researches = 0
            self.history = [(self.base_clock_ms, self.base_clock_ms) for _ in moves]
            self.paused = True
            self.manual_result = result if result in {"1-0", "0-1", "1/2-1/2"} else None
            self.manual_termination = (
                headers.get("Termination", "pgn_import") if self.manual_result is not None else None
            )
            self.pgn_headers = headers
            self.turn_started_ns = time.monotonic_ns()

    def export_pgn(self) -> str:
        """Return the current main line as a standards-compatible PGN string."""

        with self.lock:
            game = chess.pgn.Game()
            for key, value in self.pgn_headers.items():
                game.headers[key] = value
            if self.initial_fen != chess.STARTING_FEN:
                game.setup(chess.Board(self.initial_fen))

            node: chess.pgn.GameNode = game
            replay = chess.Board(self.initial_fen)
            for move in self.board.move_stack:
                if move not in replay.legal_moves:
                    raise RuntimeError("Current game history cannot be exported as legal PGN.")
                node = node.add_variation(move)
                replay.push(move)

            state = self.state()
            result = state["result"] or "*"
            game.headers["Result"] = str(result)
            if state["termination"]:
                game.headers["Termination"] = str(state["termination"]).replace("_", " ")
            return str(game)

    def review_state(self, ply: int) -> dict[str, Any]:
        """Return a board snapshot at a main-line ply without mutating the live game."""

        with self.lock:
            total = len(self.board.move_stack)
            target = max(0, min(int(ply), total))
            replay = chess.Board(self.initial_fen)
            moves = list(self.board.move_stack)
            for move in moves[:target]:
                replay.push(move)
            last_move = moves[target - 1].uci() if target else None
            captured_by_white, captured_by_black = self._captures(replay)
            return {
                "ply": target,
                "total_plies": total,
                "fen": replay.fen(),
                "turn": "white" if replay.turn == chess.WHITE else "black",
                "board": self._board_payload(replay),
                "last_move": last_move,
                "eval_cp": self._white_eval(replay),
                "check": replay.is_check(),
                "captured_by_white": captured_by_white,
                "captured_by_black": captured_by_black,
                "material_balance": self._material_balance(replay),
            }

    def review_series(self) -> dict[str, Any]:
        """Return static white-perspective evaluations for each main-line ply."""

        with self.lock:
            replay = chess.Board(self.initial_fen)
            values = [self._white_eval(replay)]
            labels = ["Start"]
            for index, move in enumerate(self.board.move_stack, start=1):
                san = replay.san(move)
                replay.push(move)
                values.append(self._white_eval(replay))
                move_number = (index + 1) // 2
                labels.append(f"{move_number}.{'..' if index % 2 == 0 else ''}{san}")
            return {"evals": values, "labels": labels, "total_plies": len(self.board.move_stack)}

    def state(self) -> dict[str, Any]:
        with self.lock:
            board = self.board
            outcome = board.outcome(claim_draw=True)
            white_ms, black_ms = self._current_clocks()
            flagged = self._clock_flag(white_ms, black_ms)
            captured_by_white, captured_by_black = self._captures(board)
            legal_moves = [move.uci() for move in board.legal_moves]
            eval_cp = self._white_eval(board)
            return {
                "fen": board.fen(),
                "turn": "white" if board.turn == chess.WHITE else "black",
                "board": self._board_payload(board),
                "legal_moves": legal_moves,
                "last_move": self.last_move.uci() if self.last_move else None,
                "white_ms": white_ms,
                "black_ms": black_ms,
                "base_clock_ms": self.base_clock_ms,
                "increment_ms": self.increment_ms,
                "eval_cp": eval_cp,
                "check": board.is_check(),
                "game_over": (
                    self.manual_result is not None or outcome is not None or flagged is not None
                ),
                "result": (
                    self.manual_result
                    if self.manual_result is not None
                    else outcome.result()
                    if outcome is not None
                    else (
                        "0-1"
                        if flagged == chess.WHITE
                        else "1-0"
                        if flagged == chess.BLACK
                        else None
                    )
                ),
                "termination": (
                    self.manual_termination
                    if self.manual_result is not None
                    else outcome.termination.name.lower()
                    if outcome is not None
                    else "time_forfeit"
                    if flagged is not None
                    else None
                ),
                "pgn": self._pgn_moves(board),
                "initial_fen": self.initial_fen,
                "moves_uci": self._moves_uci(),
                "clock_history": [[white, black] for white, black in self.history],
                "paused": self.paused,
                "manual_result": self.manual_result,
                "manual_termination": self.manual_termination,
                "pgn_headers": self.pgn_headers,
                "captured_by_white": captured_by_white,
                "captured_by_black": captured_by_black,
                "material_balance": self._material_balance(board),
                "last_engine_ms": self.last_engine_ms,
                "last_engine_nodes": self.last_engine_nodes,
                "last_engine_depth": self.last_engine_depth,
                "last_engine_score": self.last_engine_score,
                "last_engine_pv": self.last_engine_pv,
                "last_engine_researches": self.last_engine_researches,
            }

    @staticmethod
    def _board_payload(board: chess.Board) -> dict[str, str]:
        return {
            chess.square_name(square): piece.symbol()
            for square, piece in board.piece_map().items()
        }

    @staticmethod
    def _pgn_moves(board: chess.Board) -> list[dict[str, Any]]:
        replay = chess.Board(board.root().fen())
        result: list[dict[str, Any]] = []
        for ply, move in enumerate(board.move_stack):
            san = replay.san(move)
            result.append({"ply": ply + 1, "uci": move.uci(), "san": san})
            replay.push(move)
        return result

    def play_move(self, uci: str) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if self.paused:
                raise ValueError("The game is paused.")
            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise ValueError("Invalid UCI move.") from exc
            if move not in self.board.legal_moves:
                raise ValueError("That move is not legal in the current position.")
            self._commit_clock()
            mover = self.board.turn
            remaining = self.white_ms if mover == chess.WHITE else self.black_ms
            if remaining <= 0:
                side = "White" if mover == chess.WHITE else "Black"
                raise ValueError(f"{side} has flagged on time.")
            self.history.append((self.white_ms, self.black_ms))
            if mover == chess.WHITE:
                self.white_ms += self.increment_ms
            else:
                self.black_ms += self.increment_ms
            self.board.push(move)
            self.last_move = move
            self.turn_started_ns = time.monotonic_ns()

    def engine_move(self, budget_ms: int | None = None) -> str:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if self.paused:
                raise ValueError("The game is paused.")
            color = self.board.turn
            self._commit_clock()
            available = self.white_ms if color == chess.WHITE else self.black_ms
            if available <= 0:
                side = "White" if color == chess.WHITE else "Black"
                raise ValueError(f"{side} has flagged on time.")
            requested = available if budget_ms is None else min(available, max(1, budget_ms))
            fen = self.board.fen()
            before = time.monotonic_ns()
            uci = agent.get_move(fen, requested)
            elapsed_ms = max(0, (time.monotonic_ns() - before) // 1_000_000)

            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise RuntimeError(f"Engine returned malformed move {uci!r}.") from exc
            if move not in self.board.legal_moves:
                raise RuntimeError(f"Engine returned illegal move {uci!r}.")

            if color == chess.WHITE:
                self.white_ms = max(0, self.white_ms - elapsed_ms)
            else:
                self.black_ms = max(0, self.black_ms - elapsed_ms)
            self.history.append((self.white_ms, self.black_ms))
            if color == chess.WHITE:
                self.white_ms += self.increment_ms
            else:
                self.black_ms += self.increment_ms
            self.board.push(move)
            self.last_move = move
            self.last_engine_ms = int(elapsed_ms)
            info = agent.LAST_SEARCH_INFO
            self.last_engine_nodes = int(info.nodes)
            self.last_engine_depth = int(info.depth)
            self.last_engine_score = int(info.score)
            self.last_engine_pv = tuple(info.pv)
            self.last_engine_researches = int(info.aspiration_researches)
            self.turn_started_ns = time.monotonic_ns()
            return uci

    def undo(self) -> None:
        with self.lock:
            self.manual_result = None
            self.manual_termination = None
            self.paused = False
            if not self.board.move_stack:
                self.turn_started_ns = time.monotonic_ns()
                return
            self.board.pop()
            if self.history:
                self.white_ms, self.black_ms = self.history.pop()
            self.last_move = self.board.peek() if self.board.move_stack else None
            self.turn_started_ns = time.monotonic_ns()

    def set_paused(self, paused: bool) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if paused == self.paused:
                return
            if paused:
                self._commit_clock()
                self.paused = True
            else:
                self.paused = False
                self.turn_started_ns = time.monotonic_ns()

    def resign(self, color_name: str) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            if color_name not in {"white", "black"}:
                raise ValueError("Resigning color must be white or black.")
            self._commit_clock()
            self.manual_result = "0-1" if color_name == "white" else "1-0"
            self.manual_termination = "resignation"
            self.paused = True

    def agree_draw(self) -> None:
        with self.lock:
            if self.manual_result is not None or self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            self._commit_clock()
            self.manual_result = "1/2-1/2"
            self.manual_termination = "draw_agreement"
            self.paused = True


SESSION = GameSession()


class Handler(SimpleHTTPRequestHandler):
    """Static assets plus a tiny JSON API."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT / "static"), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep the terminal quiet unless there is an HTTP error.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def do_GET(self) -> None:
        if self.path == "/api/state":
            self._json(SESSION.state())
            return
        super().do_GET()

    def do_POST(self) -> None:
        try:
            payload = self._body()
            if self.path == "/api/move":
                SESSION.play_move(str(payload.get("move", "")))
            elif self.path == "/api/engine":
                budget = payload.get("budget_ms")
                SESSION.engine_move(int(budget) if budget is not None else None)
            elif self.path == "/api/reset":
                SESSION.reset(
                    str(payload.get("fen", chess.STARTING_FEN)),
                    int(payload.get("clock_ms", DEFAULT_CLOCK_MS)),
                    int(payload.get("increment_ms", DEFAULT_INCREMENT_MS)),
                )
            elif self.path == "/api/load-game":
                SESSION.load_snapshot(payload)
            elif self.path == "/api/load-pgn":
                SESSION.load_pgn(str(payload.get("pgn", "")))
            elif self.path == "/api/export-pgn":
                self._json({"pgn": SESSION.export_pgn()})
                return
            elif self.path == "/api/review":
                self._json(SESSION.review_state(int(payload.get("ply", 0))))
                return
            elif self.path == "/api/review-series":
                self._json(SESSION.review_series())
                return
            elif self.path == "/api/undo":
                SESSION.undo()
            elif self.path == "/api/pause":
                SESSION.set_paused(bool(payload.get("paused", True)))
            elif self.path == "/api/resign":
                SESSION.resign(str(payload.get("color", "")))
            elif self.path == "/api/draw":
                SESSION.agree_draw()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._json(SESSION.state())
        except (TypeError, ValueError, RuntimeError) as exc:
            self._json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)

    def _body(self) -> dict[str, Any]:
        size = int(self.headers.get("Content-Length", "0"))
        if size > 64 * 1024:
            raise ValueError("Request body is too large.")
        raw = self.rfile.read(size) if size else b"{}"
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("JSON request must be an object.")
        return value

    def _json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch the local FunChessEngine GUI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Do not open a browser tab.")
    arguments = parser.parse_args()

    port = arguments.port
    while True:
        try:
            server = ThreadingHTTPServer((arguments.host, port), Handler)
            break
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE or port >= arguments.port + 20:
                raise
            port += 1
    url = f"http://{arguments.host}:{server.server_port}"
    if arguments.port != 0 and server.server_port != arguments.port:
        print(f"Port {arguments.port} is busy; using {server.server_port} instead.")
    print(f"FunChessEngine GUI: {url}")
    if not arguments.no_open:
        threading.Timer(0.35, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
