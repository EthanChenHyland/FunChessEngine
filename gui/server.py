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
import json
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import chess

import agent

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
        self.increment_ms = DEFAULT_INCREMENT_MS
        self.last_move: chess.Move | None = None
        self.last_engine_ms = 0
        self.last_engine_nodes = 0
        self.last_engine_depth: int | None = None
        self.history: list[tuple[int, int]] = []

    def reset(self, fen: str = chess.STARTING_FEN, clock_ms: int = DEFAULT_CLOCK_MS) -> None:
        board = chess.Board(fen)
        with self.lock:
            agent.reset_game_state()
            self.board = board
            self.initial_fen = fen
            self.white_ms = max(1, int(clock_ms))
            self.black_ms = max(1, int(clock_ms))
            self.last_move = None
            self.last_engine_ms = 0
            self.last_engine_nodes = 0
            self.last_engine_depth = None
            self.history.clear()

    def state(self) -> dict[str, Any]:
        with self.lock:
            board = self.board
            outcome = board.outcome(claim_draw=True)
            legal_moves = [move.uci() for move in board.legal_moves]
            eval_cp = agent.evaluate(board)
            if board.turn == chess.BLACK:
                eval_cp = -eval_cp
            return {
                "fen": board.fen(),
                "turn": "white" if board.turn == chess.WHITE else "black",
                "board": self._board_payload(board),
                "legal_moves": legal_moves,
                "last_move": self.last_move.uci() if self.last_move else None,
                "white_ms": max(0, int(self.white_ms)),
                "black_ms": max(0, int(self.black_ms)),
                "increment_ms": self.increment_ms,
                "eval_cp": eval_cp,
                "check": board.is_check(),
                "game_over": outcome is not None,
                "result": outcome.result() if outcome else None,
                "termination": outcome.termination.name.lower() if outcome else None,
                "pgn": self._pgn_moves(board),
                "last_engine_ms": self.last_engine_ms,
                "last_engine_nodes": self.last_engine_nodes,
                "last_engine_depth": self.last_engine_depth,
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
            if self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            try:
                move = chess.Move.from_uci(uci)
            except ValueError as exc:
                raise ValueError("Invalid UCI move.") from exc
            if move not in self.board.legal_moves:
                raise ValueError("That move is not legal in the current position.")
            self.history.append((self.white_ms, self.black_ms))
            self.board.push(move)
            self.last_move = move

    def engine_move(self, budget_ms: int | None = None) -> str:
        with self.lock:
            if self.board.is_game_over(claim_draw=True):
                raise ValueError("The game is already over.")
            color = self.board.turn
            available = self.white_ms if color == chess.WHITE else self.black_ms
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

            self.history.append((self.white_ms, self.black_ms))
            if color == chess.WHITE:
                self.white_ms = max(0, self.white_ms - elapsed_ms) + self.increment_ms
            else:
                self.black_ms = max(0, self.black_ms - elapsed_ms) + self.increment_ms
            self.board.push(move)
            self.last_move = move
            self.last_engine_ms = int(elapsed_ms)
            self.last_engine_nodes = int(agent.NODES)
            entry = agent.TT.get(agent._key(chess.Board(fen)))
            self.last_engine_depth = entry.depth if entry is not None else None
            return uci

    def undo(self) -> None:
        with self.lock:
            if not self.board.move_stack:
                return
            self.board.pop()
            if self.history:
                self.white_ms, self.black_ms = self.history.pop()
            self.last_move = self.board.peek() if self.board.move_stack else None


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
                )
            elif self.path == "/api/undo":
                SESSION.undo()
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
    if server.server_port != arguments.port:
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
