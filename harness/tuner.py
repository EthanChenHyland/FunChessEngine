"""Safe in-process coordinate tuner for a small whitelist of engine parameters."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any, cast

import agent
from harness.regression import run_suite


@dataclass(frozen=True)
class Tunable:
    name: str
    minimum: int
    maximum: int
    step: int


TUNABLES = {
    "ASPIRATION_WINDOW": Tunable("ASPIRATION_WINDOW", 20, 120, 10),
    "EXCHANGE_PRUNE_MARGIN": Tunable("EXCHANGE_PRUNE_MARGIN", 40, 180, 10),
}


def objective(clock_scale: float = 0.35) -> dict[str, Any]:
    rows = run_suite(clock_scale)
    legal = sum(bool(row["legal"]) for row in rows)
    expected = sum(bool(row["expected"]) for row in rows)
    depth = sum(cast(int, row["depth"]) for row in rows)
    elapsed = sum(cast(int, row["elapsed_ms"]) for row in rows)
    # Legality and known tactical answers dominate depth; elapsed time breaks ties.
    score = legal * 100_000_000 + expected * 1_000_000 + depth * 1_000 - elapsed
    return {
        "score": score,
        "legal": legal,
        "expected": expected,
        "depth": depth,
        "elapsed_ms": elapsed,
        "rows": rows,
    }


def coordinate_tune(names: list[str] | None = None) -> dict[str, Any]:
    selected = names or list(TUNABLES)
    unknown = [name for name in selected if name not in TUNABLES]
    if unknown:
        raise ValueError(f"Unsupported tunable parameter: {unknown[0]}")
    original = {name: int(getattr(agent, name)) for name in selected}
    best_values = dict(original)
    baseline = objective()
    best_score = int(baseline["score"])
    best_correctness = (int(baseline["legal"]), int(baseline["expected"]))
    trials: list[dict[str, Any]] = []
    try:
        for name in selected:
            spec = TUNABLES[name]
            base = best_values[name]
            candidates = sorted(
                {
                    max(spec.minimum, min(spec.maximum, base - spec.step)),
                    base,
                    max(spec.minimum, min(spec.maximum, base + spec.step)),
                }
            )
            local_best = base
            for candidate in candidates:
                setattr(agent, name, candidate)
                result = objective()
                row = {"parameter": name, "value": candidate, **result}
                trials.append(row)
                correctness = (int(result["legal"]), int(result["expected"]))
                if correctness >= best_correctness and int(result["score"]) > best_score:
                    best_correctness = correctness
                    best_score = int(result["score"])
                    local_best = candidate
            best_values[name] = local_best
            setattr(agent, name, local_best)
    finally:
        for name, value in original.items():
            setattr(agent, name, value)
        agent.reset_game_state()
    return {
        "baseline": baseline,
        "original": original,
        "suggested": best_values,
        "trials": trials,
        "applied": False,
        "note": "Suggestions are never written to agent.py automatically.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("parameters", nargs="*", choices=sorted(TUNABLES))
    args = parser.parse_args()
    print(json.dumps(coordinate_tune(args.parameters or None), indent=2))


if __name__ == "__main__":
    main()
