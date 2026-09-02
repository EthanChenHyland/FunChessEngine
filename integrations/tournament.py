"""Local FunChessEngine/external-UCI tournament and calibration helpers."""

from __future__ import annotations

import json
import math
import time
from contextlib import ExitStack
from dataclasses import asdict, dataclass
from typing import Any

import chess
import chess.pgn

import agent
from harness.selfplay_data import DEFAULT_OPENINGS
from integrations.uci_client import ExternalUCIEngine


@dataclass(frozen=True)
class Participant:
    name: str
    kind: str = "external"
    executable: str = ""
    elo: int | None = None
    skill: int | None = None


@dataclass(frozen=True)
class Pairing:
    white: int
    black: int
    round: int


def round_robin_pairings(count: int, *, color_reversal: bool = True) -> list[Pairing]:
    if count < 2:
        return []
    rows: list[Pairing] = []
    round_number = 1
    for left in range(count):
        for right in range(left + 1, count):
            rows.append(Pairing(left, right, round_number))
            if color_reversal:
                rows.append(Pairing(right, left, round_number + 1))
            round_number += 2 if color_reversal else 1
    return rows


def gauntlet_pairings(count: int, *, color_reversal: bool = True) -> list[Pairing]:
    if count < 2:
        return []
    rows: list[Pairing] = []
    for opponent in range(1, count):
        rows.append(Pairing(0, opponent, opponent))
        if color_reversal:
            rows.append(Pairing(opponent, 0, opponent))
    return rows


def _swiss_round(
    count: int,
    points: list[float],
    seen: set[tuple[int, int]],
    round_number: int,
    byes: set[int] | None = None,
) -> tuple[list[Pairing], int | None]:
    order = sorted(range(count), key=lambda index: (-points[index], index))
    bye: int | None = None
    if len(order) % 2:
        prior = byes or set()
        bye = min(order, key=lambda index: (index in prior, points[index], -index))
        order.remove(bye)
    pairings: list[Pairing] = []
    while order:
        left = order.pop(0)
        opponent_index = next(
            (
                index
                for index, candidate in enumerate(order)
                if tuple(sorted((left, candidate))) not in seen
            ),
            0,
        )
        right = order.pop(opponent_index)
        seen.add((min(left, right), max(left, right)))
        if (round_number + len(pairings)) % 2:
            left, right = right, left
        pairings.append(Pairing(left, right, round_number))
    return pairings, bye


def performance_elo(base_elo: int, score: float) -> int:
    bounded = max(0.01, min(0.99, float(score)))
    delta = 400.0 * math.log10(bounded / (1.0 - bounded))
    return round(max(100, min(4000, base_elo + delta)))


def score_interval(points: float, games: int) -> tuple[float, float]:
    if games <= 0:
        return 0.0, 1.0
    proportion = max(0.0, min(1.0, points / games))
    z = 1.96
    denominator = 1.0 + z * z / games
    center = (proportion + z * z / (2 * games)) / denominator
    half = (
        z * math.sqrt((proportion * (1 - proportion) + z * z / (4 * games)) / games) / denominator
    )
    return max(0.0, center - half), min(1.0, center + half)


class _InternalEngine:
    name = "FunChessEngine"

    def new_game(self) -> None:
        agent.reset_game_state()

    def move(self, board: chess.Board, movetime_ms: int) -> str:
        agent.set_game_history(board)
        raw = agent.get_move(board.fen(), 60_000, move_budget_ms=movetime_ms)
        move = chess.Move.from_uci(raw)
        if move not in board.legal_moves:
            raise RuntimeError(f"FunChessEngine returned illegal tournament move {raw}.")
        return raw


class _ExternalEngine:
    def __init__(self, participant: Participant, stack: ExitStack) -> None:
        if not participant.executable:
            raise ValueError(f"External participant {participant.name!r} has no executable path.")
        self.engine = stack.enter_context(ExternalUCIEngine(participant.executable, timeout_s=12.0))
        self.name = self.engine.engine_name or participant.name
        self.applied = self.engine.configure_strength(participant.elo, participant.skill)
        if participant.elo is not None and self.applied.get("elo") != participant.elo:
            raise ValueError(
                f"{self.name} cannot apply requested UCI Elo {participant.elo}; "
                f"applied settings: {self.applied}. Choose a supported reference setting."
            )
        self.engine.new_game()

    def move(self, board: chess.Board, movetime_ms: int) -> str:
        return self.engine.bestmove(board.fen(), movetime_ms).move


def _player(participant: Participant, stack: ExitStack) -> _InternalEngine | _ExternalEngine:
    if participant.kind == "funchess":
        engine = _InternalEngine()
        engine.new_game()
        return engine
    if participant.kind != "external":
        raise ValueError(f"Unknown tournament participant kind {participant.kind!r}.")
    return _ExternalEngine(participant, stack)


def play_game(
    white: Participant,
    black: Participant,
    *,
    movetime_ms: int = 80,
    initial_fen: str = chess.STARTING_FEN,
    max_plies: int = 180,
) -> dict[str, Any]:
    board = chess.Board(initial_fen)
    if not board.is_valid():
        raise ValueError("Tournament opening FEN is invalid.")
    budget = max(20, min(2_000, int(movetime_ms)))
    elapsed = {"white": 0, "black": 0}
    with ExitStack() as stack:
        white_engine = _player(white, stack)
        black_engine = _player(black, stack)
        for _ply in range(max(1, min(300, int(max_plies)))):
            if board.is_game_over(claim_draw=True):
                break
            engine = white_engine if board.turn == chess.WHITE else black_engine
            started = time.monotonic_ns()
            raw = engine.move(board, budget)
            elapsed["white" if board.turn else "black"] += (
                time.monotonic_ns() - started
            ) // 1_000_000
            move = board.parse_uci(raw)
            if move not in board.legal_moves:
                raise RuntimeError(f"Tournament engine returned illegal move {raw}.")
            board.push(move)
    outcome = board.outcome(claim_draw=True)
    result = outcome.result() if outcome is not None else "1/2-1/2"
    termination = outcome.termination.name.lower() if outcome is not None else "max_plies"
    game = chess.pgn.Game.from_board(board)
    game.headers["Event"] = "FunChessEngine Local Tournament"
    game.headers["White"] = white.name
    game.headers["Black"] = black.name
    game.headers["Result"] = result
    game.headers["Termination"] = termination
    return {
        "result": result,
        "termination": termination,
        "pgn": str(game),
        "elapsed_ms": elapsed,
        "requested_movetime_ms": budget,
        "engines": [
            {"name": engine.name, "settings": getattr(engine, "applied", {})}
            for engine in (white_engine, black_engine)
        ],
    }


def _participants(raw: list[dict[str, Any]]) -> list[Participant]:
    if not 2 <= len(raw) <= 12:
        raise ValueError("Tournament requires between 2 and 12 participants.")
    result: list[Participant] = []
    for index, item in enumerate(raw):
        name = str(item.get("name", f"Engine {index + 1}")).strip()[:80]
        if not name:
            raise ValueError("Tournament participant names cannot be empty.")
        kind = str(item.get("kind", "external")).strip().lower()
        result.append(
            Participant(
                name=name,
                kind=kind,
                executable=str(item.get("executable", "")),
                elo=int(item["elo"]) if item.get("elo") is not None else None,
                skill=int(item["skill"]) if item.get("skill") is not None else None,
            )
        )
    return result


def run_tournament(payload: dict[str, Any]) -> dict[str, Any]:
    raw_participants = payload.get("participants", [])
    if not isinstance(raw_participants, list) or not all(
        isinstance(item, dict) for item in raw_participants
    ):
        raise ValueError("Participants must be a list of objects.")
    participants = _participants(raw_participants)
    format_name = str(payload.get("format", "round_robin")).strip().lower()
    color_reversal = bool(payload.get("color_reversal", True))
    movetime_ms = max(20, min(2_000, int(payload.get("movetime_ms", 80))))
    openings = [str(item) for item in payload.get("openings", []) if str(item).strip()]
    if not openings:
        openings = [chess.STARTING_FEN]
    if len(openings) > 32:
        raise ValueError("Opening suite supports at most 32 positions.")
    for fen in openings:
        if not chess.Board(fen).is_valid():
            raise ValueError("Tournament opening suite contains an invalid FEN.")
    if format_name == "round_robin":
        schedule = round_robin_pairings(len(participants), color_reversal=color_reversal)
    elif format_name == "gauntlet":
        schedule = gauntlet_pairings(len(participants), color_reversal=color_reversal)
    elif format_name == "swiss":
        schedule = []
    else:
        raise ValueError("Tournament format must be round_robin, gauntlet, or swiss.")

    standings: list[dict[str, Any]] = [
        {
            "name": item.name,
            "games": 0,
            "points": 0.0,
            "byes": 0,
            "wins": 0,
            "draws": 0,
            "losses": 0,
        }
        for item in participants
    ]
    games: list[dict[str, Any]] = []

    def run_pairing(pairing: Pairing, game_index: int) -> None:
        white = participants[pairing.white]
        black = participants[pairing.black]
        game = play_game(
            white,
            black,
            movetime_ms=movetime_ms,
            initial_fen=openings[
                (game_index // (2 if color_reversal and format_name != "swiss" else 1))
                % len(openings)
            ],
        )
        result = str(game["result"])
        standings[pairing.white]["games"] += 1
        standings[pairing.black]["games"] += 1
        if result == "1-0":
            standings[pairing.white]["wins"] += 1
            standings[pairing.white]["points"] += 1.0
            standings[pairing.black]["losses"] += 1
        elif result == "0-1":
            standings[pairing.black]["wins"] += 1
            standings[pairing.black]["points"] += 1.0
            standings[pairing.white]["losses"] += 1
        else:
            standings[pairing.white]["draws"] += 1
            standings[pairing.black]["draws"] += 1
            standings[pairing.white]["points"] += 0.5
            standings[pairing.black]["points"] += 0.5
        games.append({"pairing": asdict(pairing), "white": white.name, "black": black.name, **game})
        print(
            json.dumps(
                {
                    "type": "progress",
                    "completed": len(games),
                    "total": len(schedule) if schedule else rounds * (len(participants) // 2),
                    "partial": {
                        "format": format_name,
                        "standings": standings,
                        "games": games,
                        "complete": False,
                        "pgn": "\n\n".join(str(row["pgn"]) for row in games),
                    },
                }
            ),
            flush=True,
        )

    rounds = 0
    if format_name == "swiss":
        rounds = max(1, min(8, int(payload.get("rounds", 3))))
        seen: set[tuple[int, int]] = set()
        byes: set[int] = set()
        for round_number in range(1, rounds + 1):
            round_points = [float(row["points"]) for row in standings]
            pairings, bye = _swiss_round(len(participants), round_points, seen, round_number, byes)
            if bye is not None:
                standings[bye]["points"] += 1.0
                standings[bye]["byes"] += 1
                byes.add(bye)
            for pairing in pairings:
                run_pairing(pairing, len(games))
    else:
        for pairing in schedule:
            run_pairing(pairing, len(games))

    for index, row in enumerate(standings):
        games_played = int(row["games"])
        points = float(row["points"]) - int(row["byes"])
        score = points / games_played if games_played else 0.5
        low, high = score_interval(points, games_played)
        opponents = [
            participants[
                g["pairing"]["black"] if g["pairing"]["white"] == index else g["pairing"]["white"]
            ].elo
            for g in games
            if index in (g["pairing"]["white"], g["pairing"]["black"])
        ]
        row["score"] = score
        row["performance_elo"] = (
            performance_elo(
                round(sum(value for value in opponents if value is not None) / len(opponents)),
                score,
            )
            if opponents and all(value is not None for value in opponents)
            else None
        )
        row["score_interval"] = [low, high]
    standings.sort(key=lambda row: (-float(row["points"]), -float(row["score"]), str(row["name"])))
    return {
        "format": format_name,
        "complete": True,
        "rating_note": "Performance relative to supplied UCI settings, not a universal Elo rating.",
        "movetime_ms": movetime_ms,
        "participants": [asdict(item) for item in participants],
        "standings": standings,
        "games": games,
        "pgn": "\n\n".join(str(game["pgn"]) for game in games),
    }


def calibrate_against_uci(payload: dict[str, Any]) -> dict[str, Any]:
    executable = str(payload.get("executable", ""))
    opponent_elo = int(payload.get("opponent_elo", 1500))
    if not 400 <= opponent_elo <= 3500:
        raise ValueError("Calibration reference Elo must be between 400 and 3500.")
    games = max(2, min(12, int(payload.get("games", 4))))
    if games % 2:
        games += 1
    external = Participant("Calibration opponent", "external", executable, opponent_elo)
    ours = Participant("FunChessEngine", "funchess")
    points = 0.0
    rows: list[dict[str, Any]] = []
    for index in range(games):
        white, black = (ours, external) if index % 2 == 0 else (external, ours)
        game = play_game(
            white,
            black,
            movetime_ms=max(20, min(1_000, int(payload.get("movetime_ms", 80)))),
            initial_fen=DEFAULT_OPENINGS[(index // 2) % len(DEFAULT_OPENINGS)],
        )
        result = str(game["result"])
        if result == "1/2-1/2":
            points += 0.5
        elif (result == "1-0") == (white.kind == "funchess"):
            points += 1.0
        rows.append(game)
        print(
            json.dumps(
                {
                    "type": "progress",
                    "completed": len(rows),
                    "total": games,
                    "partial": {"results": rows, "points": points},
                }
            ),
            flush=True,
        )
    score = points / games
    low, high = score_interval(points, games)
    return {
        "games": games,
        "points": points,
        "score": score,
        "opponent_elo": opponent_elo,
        "rating_note": "Local performance against verified UCI strength; not FIDE/online Elo.",
        "estimated_elo": performance_elo(opponent_elo, score),
        "elo_interval": [performance_elo(opponent_elo, low), performance_elo(opponent_elo, high)],
        "results": rows,
    }
