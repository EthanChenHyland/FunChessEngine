import argparse
import json
import math
from pathlib import Path

import chess

from harness.referee import FAILED_TERMINATIONS, play_match
from harness.rules import PLY_CAP
from harness.sandbox import local

FAST_BASE_MS = 10_000
FAST_INCREMENT_MS = 100


def load_openings(path: Path | None) -> list[str]:
    """Load optional legal non-terminal FENs used as paired A/B starts."""

    if path is None:
        return [chess.STARTING_FEN]
    openings: list[str] = []
    for number, raw in enumerate(path.read_text().splitlines(), start=1):
        fen = raw.strip()
        if not fen or fen.startswith("#"):
            continue
        try:
            board = chess.Board(fen)
        except ValueError as exc:
            raise ValueError(f"invalid FEN on line {number}: {exc}") from exc
        if not board.is_valid() or board.is_game_over(claim_draw=True):
            raise ValueError(f"opening on line {number} must be a valid non-terminal position")
        openings.append(board.fen())
    if not openings:
        raise ValueError("opening file does not contain any usable FEN positions")
    return openings


def elo_from_score(score: float) -> float | None:
    """Return the logistic Elo estimate for a match score, excluding 0/100% infinities."""

    if score <= 0.0 or score >= 1.0:
        return None
    return 400.0 * math.log10(score / (1.0 - score))


def score_interval(wins: int, draws: int, losses: int) -> tuple[float, float]:
    """Approximate 95% Wilson interval, treating each draw as one half-point."""

    games = wins + draws + losses
    if games <= 0:
        return 0.0, 1.0
    # Two pseudo-trials per game represent the match points exactly:
    # win=2/2, draw=1/2, loss=0/2. This is intentionally an approximate
    # uncertainty display, not a replacement for SPRT or a large match.
    trials = games * 2
    successes = wins * 2 + draws
    p = successes / trials
    z = 1.96
    z2 = z * z
    denominator = 1.0 + z2 / trials
    center = (p + z2 / (2 * trials)) / denominator
    margin = z * math.sqrt((p * (1.0 - p) + z2 / (4 * trials)) / trials) / denominator
    return max(0.0, center - margin), min(1.0, center + margin)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score an agent over several games.")
    parser.add_argument("--agent", type=Path, default=Path("."))
    parser.add_argument("--opponent", type=Path, default=Path("baselines/greedy"))
    parser.add_argument("--games", type=int, default=20)
    parser.add_argument("--base-ms", type=int, default=FAST_BASE_MS)
    parser.add_argument("--increment-ms", type=int, default=FAST_INCREMENT_MS)
    parser.add_argument("--ply-cap", type=int, default=PLY_CAP)
    parser.add_argument(
        "--fen-file", type=Path, help="Optional one-FEN-per-line paired opening suite."
    )
    parser.add_argument(
        "--json", type=Path, dest="json_path", help="Write machine-readable results."
    )
    arguments = parser.parse_args()

    agent = arguments.agent.resolve()
    opponent = arguments.opponent.resolve()
    openings = load_openings(arguments.fen_file)
    wins = draws = losses = 0
    terminations: dict[str, int] = {}
    game_results: list[dict[str, object]] = []

    for game in range(arguments.games):
        plays_white = game % 2 == 0
        white, black = (agent, opponent) if plays_white else (opponent, agent)
        start_fen = openings[(game // 2) % len(openings)]
        outcome = play_match(
            local(white),
            local(black),
            arguments.base_ms,
            arguments.increment_ms,
            ply_cap=arguments.ply_cap,
            start_fen=start_fen,
        )
        terminations[outcome.termination] = terminations.get(outcome.termination, 0) + 1
        if outcome.result == "draw" or outcome.result == "void":
            draws += 1
        elif (outcome.result == "white") == plays_white:
            wins += 1
        else:
            losses += 1
        game_results.append(
            {
                "game": game + 1,
                "agent_color": "white" if plays_white else "black",
                "result": outcome.result,
                "termination": outcome.termination,
                "start_fen": start_fen,
            }
        )
        print(f"game {game + 1}/{arguments.games}: {outcome.result} by {outcome.termination}")

    score = (wins + draws / 2) / arguments.games
    elo = elo_from_score(score)
    score_low, score_high = score_interval(wins, draws, losses)
    elo_low = elo_from_score(score_low)
    elo_high = elo_from_score(score_high)
    print(f"\n{arguments.agent} vs {arguments.opponent} over {arguments.games} games")
    print(f"+{wins} ={draws} -{losses}, score {score:.1%}")
    print(f"approx. 95% score interval {score_low:.1%} to {score_high:.1%}")
    if elo is not None:
        interval = (
            f" [{elo_low:+.0f}, {elo_high:+.0f}]"
            if elo_low is not None and elo_high is not None
            else ""
        )
        print(f"logistic Elo estimate {elo:+.0f}{interval} (approximate; small samples are noisy)")
    print("terminations: " + ", ".join(f"{name} {count}" for name, count in terminations.items()))
    broken = {name: count for name, count in terminations.items() if name in FAILED_TERMINATIONS}
    if broken:
        raise SystemExit(
            "your agent failed to finish a game: "
            + ", ".join(f"{name} {count}" for name, count in broken.items())
        )
    if arguments.json_path is not None:
        arguments.json_path.write_text(
            json.dumps(
                {
                    "agent": str(agent),
                    "opponent": str(opponent),
                    "games": arguments.games,
                    "base_ms": arguments.base_ms,
                    "increment_ms": arguments.increment_ms,
                    "wins": wins,
                    "draws": draws,
                    "losses": losses,
                    "score": score,
                    "score_interval_95": [score_low, score_high],
                    "elo_estimate": elo,
                    "elo_interval_95": [elo_low, elo_high],
                    "terminations": terminations,
                    "results": game_results,
                },
                indent=2,
            )
            + "\n"
        )


if __name__ == "__main__":
    main()
