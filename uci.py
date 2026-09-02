"""Minimal standard UCI adapter for the standalone FunChessEngine search.

This module deliberately stays outside ``agent.py`` so the competition/runtime
``get_move(fen, time_left_ms)`` contract is unchanged.  It can be launched with
``python -m uci`` (or ``make uci``) by chess GUIs that speak the Universal Chess
Interface protocol.
"""

from __future__ import annotations

import sys
from collections.abc import Iterable
from contextlib import suppress
from typing import TextIO

import chess

import agent

ENGINE_NAME = "FunChessEngine 1.0"
ENGINE_AUTHOR = "FunChessEngine contributors"
DEFAULT_CLOCK_MS = 60_000
MAX_SYNTHETIC_CLOCK_MS = 1_000_000_000


class UCIAdapter:
    """Small synchronous UCI command dispatcher around :mod:`agent`."""

    def __init__(self, output: TextIO = sys.stdout) -> None:
        self.output = output
        self.chess960 = False
        self.board = chess.Board()

    def _send(self, line: str) -> None:
        print(line, file=self.output, flush=True)

    def _new_board(self) -> chess.Board:
        return chess.Board(chess960=self.chess960)

    def _set_position(self, tokens: list[str]) -> None:
        if not tokens:
            return

        try:
            if tokens[0] == "startpos":
                board = self._new_board()
                cursor = 1
            elif tokens[0] == "fen":
                try:
                    moves_index = tokens.index("moves", 1)
                except ValueError:
                    moves_index = len(tokens)
                fen = " ".join(tokens[1:moves_index])
                board = chess.Board(fen, chess960=self.chess960)
                cursor = moves_index
            else:
                return

            if cursor < len(tokens):
                if tokens[cursor] != "moves":
                    return
                for raw_move in tokens[cursor + 1 :]:
                    board.push_uci(raw_move)
        except ValueError:
            # UCI has no required error response for malformed position input.
            # Keep the last valid board and, importantly, keep stdout protocol-only.
            return

        self.board = board

    @staticmethod
    def _parse_go_options(tokens: Iterable[str]) -> dict[str, int]:
        options: dict[str, int] = {}
        items = list(tokens)
        timed_options = {"wtime", "btime", "winc", "binc", "movetime"}
        cursor = 0
        while cursor < len(items):
            name = items[cursor]
            if name not in timed_options or cursor + 1 >= len(items):
                cursor += 1
                continue
            with suppress(ValueError):
                options[name] = max(0, int(items[cursor + 1]))
            cursor += 2
        return options

    def _clock_for_movetime(self, movetime_ms: int) -> int:
        """Invert the existing engine budget approximately for UCI ``movetime``.

        ``get_move`` accepts remaining clock rather than a per-move deadline.
        Binary-searching its unchanged budget helper lets the adapter honor a
        requested move time closely (up to the engine's existing 2.5 s search
        cap) without changing competition behavior.
        """

        target_ms = max(1, movetime_ms)
        low = 1
        high = MAX_SYNTHETIC_CLOCK_MS
        if agent._time_budget_ms(self.board, high) < target_ms:
            return high

        while low < high:
            middle = (low + high) // 2
            if agent._time_budget_ms(self.board, middle) >= target_ms:
                high = middle
            else:
                low = middle + 1
        return low

    def _time_left_for_go(self, tokens: list[str]) -> int:
        options = self._parse_go_options(tokens)
        movetime = options.get("movetime")
        if movetime is not None:
            return self._clock_for_movetime(max(1, movetime))

        if self.board.turn == chess.WHITE:
            remaining = options.get("wtime")
            increment = options.get("winc", 0)
        else:
            remaining = options.get("btime")
            increment = options.get("binc", 0)

        if remaining is None:
            return DEFAULT_CLOCK_MS

        # The search API has no increment parameter.  Give it at most one
        # current-clock's worth of increment credit, which lets increments
        # modestly increase search while staying conservative in time trouble.
        increment_credit = min(increment, remaining)
        return max(1, remaining + increment_credit)

    def _go(self, tokens: list[str]) -> None:
        legal = list(self.board.legal_moves)
        if not legal:
            self._send("bestmove 0000")
            return

        time_left_ms = self._time_left_for_go(tokens)
        engine_fen = self.board.fen(shredder=self.chess960)
        try:
            raw_move = agent.get_move(engine_fen, time_left_ms)
            move = self.board.parse_uci(raw_move)
            if move not in self.board.legal_moves:
                raise ValueError("engine returned an illegal move")
        except (AssertionError, TypeError, ValueError):
            # Keep the UCI contract legal even if bad input or an unexpected
            # adapter/engine mismatch reaches this boundary.
            move = legal[0]

        self._send(f"bestmove {self.board.uci(move, chess960=self.chess960)}")

    def _set_option(self, tokens: list[str]) -> None:
        lowered = [token.lower() for token in tokens]
        try:
            name_index = lowered.index("name")
        except ValueError:
            return
        try:
            value_index = lowered.index("value", name_index + 1)
        except ValueError:
            value_index = len(tokens)

        name = " ".join(tokens[name_index + 1 : value_index]).strip().lower()
        if name != "uci_chess960":
            return
        value = " ".join(tokens[value_index + 1 :]).strip().lower()
        self.chess960 = value in {"1", "true", "yes", "on"}

    def handle_line(self, line: str) -> bool:
        """Handle one UCI input line; return ``False`` after ``quit``."""

        tokens = line.strip().split()
        if not tokens:
            return True
        command = tokens[0].lower()
        arguments = tokens[1:]

        if command == "uci":
            self._send(f"id name {ENGINE_NAME}")
            self._send(f"id author {ENGINE_AUTHOR}")
            self._send("option name UCI_Chess960 type check default false")
            self._send("uciok")
        elif command == "isready":
            self._send("readyok")
        elif command == "setoption":
            self._set_option(arguments)
        elif command == "ucinewgame":
            agent.reset_game_state()
            self.board = self._new_board()
        elif command == "position":
            self._set_position(arguments)
        elif command == "go":
            self._go(arguments)
        elif command == "quit":
            return False
        return True


def main() -> None:
    adapter = UCIAdapter()
    for line in sys.stdin:
        if not adapter.handle_line(line):
            break


if __name__ == "__main__":
    main()
