"""Safe data-only plugin manifest validation.

Plugins are deliberately JSON data, not imported Python or JavaScript.  They may
contribute training positions, opening labels, and command metadata only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import chess

MAX_PLUGIN_BYTES = 256 * 1024
MAX_ITEMS = 500
ALLOWED_KINDS = {"training", "openings", "commands"}


@dataclass(frozen=True)
class PluginManifest:
    plugin_id: str
    name: str
    version: str
    kind: str
    items: tuple[dict[str, Any], ...]
    enabled: bool = False


def _bounded_text(value: Any, field: str, limit: int) -> str:
    text = str(value or "").strip()
    if not text or len(text) > limit:
        raise ValueError(f"Plugin {field} is invalid.")
    return text


def validate_manifest(payload: Any) -> PluginManifest:
    if not isinstance(payload, dict):
        raise ValueError("Plugin manifest must be a JSON object.")
    plugin_id = _bounded_text(payload.get("id"), "id", 64)
    if not all(char.isalnum() or char in "._-" for char in plugin_id):
        raise ValueError("Plugin id contains unsupported characters.")
    name = _bounded_text(payload.get("name"), "name", 80)
    version = _bounded_text(payload.get("version"), "version", 32)
    kind = _bounded_text(payload.get("kind"), "kind", 24).lower()
    if kind not in ALLOWED_KINDS:
        raise ValueError("Plugin kind is not supported.")
    raw_items = payload.get("items", [])
    if not isinstance(raw_items, list) or len(raw_items) > MAX_ITEMS:
        raise ValueError("Plugin item list is invalid or too large.")
    items: list[dict[str, Any]] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("Plugin items must be JSON objects.")
        item = dict(raw)
        if kind == "training":
            fen = _bounded_text(item.get("fen"), "training FEN", 120)
            board = chess.Board(fen)
            if not board.is_valid():
                raise ValueError("Plugin training position is invalid.")
            item["fen"] = board.fen()
            item["title"] = _bounded_text(item.get("title", "Training position"), "title", 100)
        elif kind == "openings":
            item["name"] = _bounded_text(item.get("name"), "opening name", 100)
            moves = item.get("moves", [])
            if not isinstance(moves, list) or len(moves) > 40:
                raise ValueError("Plugin opening move list is invalid.")
            board = chess.Board()
            normalized: list[str] = []
            for raw_move in moves:
                move = chess.Move.from_uci(str(raw_move))
                if move not in board.legal_moves:
                    raise ValueError("Plugin opening contains an illegal move.")
                normalized.append(move.uci())
                board.push(move)
            item["moves"] = normalized
        else:
            item["label"] = _bounded_text(item.get("label"), "command label", 80)
            item["action"] = _bounded_text(item.get("action"), "command action", 64)
        items.append(item)
    return PluginManifest(plugin_id, name, version, kind, tuple(items), enabled=False)


def load_manifest(path: str | Path) -> PluginManifest:
    manifest_path = Path(path)
    if not manifest_path.is_file():
        raise ValueError("Plugin manifest file does not exist.")
    if manifest_path.stat().st_size > MAX_PLUGIN_BYTES:
        raise ValueError("Plugin manifest is too large.")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Plugin manifest could not be read as JSON.") from exc
    return validate_manifest(payload)

