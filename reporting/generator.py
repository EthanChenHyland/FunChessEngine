"""Generate bounded local chess reports without external services."""

from __future__ import annotations

import html
import io
from typing import Any

import chess.pgn

MAX_GAMES = 500
MAX_REPORT_TEXT = 200_000


def _text(value: Any, limit: int = 200) -> str:
    return str(value or "")[:limit]


def annotated_pgn(pgn_text: str, analysis: list[dict[str, Any]]) -> str:
    if len(pgn_text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("PGN is too large to annotate.")
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None or game.errors:
        raise ValueError("PGN could not be parsed for annotation.")
    nodes = list(game.mainline())
    by_ply = {int(item.get("ply", -1)): item for item in analysis if isinstance(item, dict)}
    for ply, node in enumerate(nodes, start=1):
        item = by_ply.get(ply)
        if not item:
            continue
        classification = _text(item.get("classification", "Move"), 32)
        cpl = max(0, int(item.get("cpl", 0)))
        best = _text(item.get("best_san", item.get("best_uci", "")), 32)
        explanation = _text(item.get("explanation", ""), 240)
        parts = [f"FunChessEngine: {classification}, {cpl} CPL"]
        if best:
            parts.append(f"best {best}")
        if explanation:
            parts.append(explanation)
        node.comment = " | ".join(parts)
        if classification == "Blunder":
            node.nags.add(chess.pgn.NAG_BLUNDER)
        elif classification == "Mistake":
            node.nags.add(chess.pgn.NAG_MISTAKE)
        elif classification == "Inaccuracy":
            node.nags.add(chess.pgn.NAG_DUBIOUS_MOVE)
    return str(game)


def html_report(title: str, games: list[dict[str, Any]], profile: dict[str, Any]) -> str:
    if len(games) > MAX_GAMES:
        raise ValueError("Report contains too many games.")
    safe_title = html.escape(_text(title or "FunChessEngine report", 120))
    rows: list[str] = []
    for game in games:
        opening = html.escape(_text(game.get("opening", "Unknown"), 120))
        result = html.escape(_text(game.get("result", "*"), 16))
        accuracy = html.escape(_text(game.get("accuracy", "—"), 24))
        date = html.escape(_text(game.get("date", ""), 40))
        rows.append(
            f"<tr><td>{date}</td><td>{opening}</td><td>{result}</td><td>{accuracy}</td></tr>"
        )
    profile_items = "".join(
        f"<li><strong>{html.escape(_text(key, 60))}</strong>: "
        f"{html.escape(_text(value, 160))}</li>"
        for key, value in list(profile.items())[:50]
    )
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{safe_title}</title><style>
body{{font:15px system-ui,sans-serif;max-width:1000px;margin:40px auto;padding:0 24px;
color:#181818}}
h1{{font-size:28px}} table{{border-collapse:collapse;width:100%}}
th,td{{padding:8px;border-bottom:1px solid #ddd;text-align:left}}
</style></head><body><h1>{safe_title}</h1><h2>Profile</h2><ul>{profile_items}</ul>
<h2>Games</h2><table><thead><tr><th>Date</th><th>Opening</th><th>Result</th><th>Accuracy</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></body></html>"""
    if len(document) > MAX_REPORT_TEXT:
        raise ValueError("Generated report exceeds the local size limit.")
    return document
