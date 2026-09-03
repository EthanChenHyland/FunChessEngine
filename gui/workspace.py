"""Host-local streaming uploads, consistent database snapshots and workspace bundles."""

from __future__ import annotations

import atexit
import base64
import hashlib
import json
import shutil
import sqlite3
import tempfile
import time
import uuid
import zipfile
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

from librarydb.connections import DATABASE_LOCK
from librarydb.store import LibraryDatabase, default_data_dir
from openingbook.store import OpeningBook

MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024
LOCK = DATABASE_LOCK
_FILES: dict[str, dict[str, Any]] = {}
_TEMP = Path(tempfile.mkdtemp(prefix="funchess-transfers-"))
DATABASES = {
    "library.sqlite3": {"games", "positions", "position_tags"},
    "opening-book.sqlite3": {"book_moves"},
}


def _prune() -> None:
    for token, row in list(_FILES.items()):
        if time.time() - row["created"] > 3600 and not row.get("in_use"):
            Path(row["path"]).unlink(missing_ok=True)
            del _FILES[token]


def upload(payload: dict[str, Any]) -> dict[str, Any]:
    with LOCK:
        _prune()
        action = payload.get("action", "start")
        if action == "start":
            if len(_FILES) >= 6:
                raise ValueError("Too many pending transfers. Cancel one or retry later.")
            size = int(payload.get("size", 0))
            if not 0 < size <= MAX_FILE_BYTES:
                raise ValueError("File must be between 1 byte and 1 GB.")
            token = uuid.uuid4().hex
            path = _TEMP / token
            path.touch()
            _FILES[token] = {
                "path": path,
                "size": size,
                "received": 0,
                "created": time.time(),
                "complete": False,
                "name": str(payload.get("name", "Import"))[:200],
            }
            return {"token": token}
        token = str(payload.get("token", ""))
        row = _FILES.get(token)
        if row is None:
            raise ValueError("Transfer expired or is unknown.")
        if action == "cancel":
            if row.get("in_use"):
                raise ValueError("Cancel the import job before removing its transfer.")
            Path(row["path"]).unlink(missing_ok=True)
            del _FILES[token]
            return {"cancelled": True}
        if row["complete"] or row.get("in_use"):
            raise ValueError("Transfer is already finalized.")
        if action == "chunk":
            if int(payload.get("offset", -1)) != row["received"]:
                raise ValueError("Upload offset does not match received bytes.")
            chunk = base64.b64decode(str(payload.get("data", "")), validate=True)
            if not chunk or len(chunk) > 1024 * 1024 or row["received"] + len(chunk) > row["size"]:
                raise ValueError("Upload chunk exceeds the declared size or 1 MB chunk limit.")
            with Path(row["path"]).open("ab") as output:
                output.write(chunk)
            row["received"] += len(chunk)
            return {"received": row["received"]}
        if action == "finish":
            if row["received"] != row["size"]:
                raise ValueError("Upload is incomplete.")
            row["complete"] = True
            return {"token": token, "complete": True}
        raise ValueError("Unknown transfer action.")


def uploaded_file(token: str) -> tuple[Path, str]:
    with LOCK:
        row = _FILES.get(token)
        if not row or not row["complete"]:
            raise ValueError("Upload is missing or incomplete.")
        return Path(row["path"]), str(row["name"])


@contextmanager
def leased_file(token: str) -> Iterator[tuple[Path, str]]:
    with LOCK:
        value = uploaded_file(token)
        if _FILES[token].get("in_use"):
            raise ValueError("Transfer is already in use.")
        _FILES[token]["in_use"] = True
    try:
        yield value
    finally:
        with LOCK:
            _FILES[token]["in_use"] = False
            _FILES[token]["created"] = time.time()


def _snapshot(source: Path, destination: Path) -> None:
    # sqlite backup includes committed WAL pages and produces a standalone database.
    with closing(sqlite3.connect(source)) as live, closing(sqlite3.connect(destination)) as copy:
        live.backup(copy)


def create_bundle(metadata: dict[str, Any], include_reference: bool) -> dict[str, Any]:
    raw = json.dumps(metadata, ensure_ascii=False).encode()
    if len(raw) > MAX_METADATA_BYTES:
        raise ValueError("Workspace metadata exceeds 16 MB.")
    root = default_data_dir()
    token = uuid.uuid4().hex
    output = _TEMP / token
    included = ["workspace.json"]
    with LOCK, tempfile.TemporaryDirectory() as staging:
        _prune()
        if len(_FILES) >= 6:
            raise ValueError("Too many pending transfers.")
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("workspace.json", raw)
            for name in DATABASES:
                if name == "library.sqlite3" and not include_reference:
                    continue
                source = root / name
                if source.exists():
                    if source.stat().st_size > MAX_FILE_BYTES:
                        raise ValueError("Database exceeds 1 GB; exclude the reference database.")
                    copy = Path(staging) / name
                    _snapshot(source, copy)
                    archive.write(copy, name)
                    included.append(name)
            manifest = {
                "format": "FunChessEngine.WorkspaceBundle",
                "version": 1,
                "included": included,
                "reference_requested": include_reference,
            }
            archive.writestr("manifest.json", json.dumps(manifest))
        if output.stat().st_size > MAX_FILE_BYTES:
            output.unlink()
            raise ValueError("Compressed bundle exceeds 1 GB.")
        _FILES[token] = {
            "path": output,
            "size": output.stat().st_size,
            "received": output.stat().st_size,
            "complete": True,
            "name": "FunChessEngine-workspace.fce.zip",
            "created": time.time(),
        }
    return {"token": token, "manifest": manifest}


def inspect_bundle(token: str) -> dict[str, Any]:
    path, _ = uploaded_file(token)
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            allowed = {"manifest.json", "workspace.json", *DATABASES}
            if len(names) != len(set(names)) or not set(names) <= allowed:
                raise ValueError("Backup has duplicate or unexpected entries.")
            if not {"manifest.json", "workspace.json"} <= set(names):
                raise ValueError("Backup is missing its manifest or workspace metadata.")
            if sum(info.file_size for info in infos) > MAX_FILE_BYTES:
                raise ValueError("Expanded backup exceeds 1 GB.")
            if archive.getinfo("workspace.json").file_size > MAX_METADATA_BYTES:
                raise ValueError("Workspace metadata is too large.")
            if archive.getinfo("manifest.json").file_size > 8192:
                raise ValueError("Backup manifest is too large.")
            manifest = json.loads(archive.read("manifest.json"))
            if not isinstance(manifest, dict):
                raise ValueError("Backup manifest must be an object.")
            if sorted(manifest.get("included", [])) != sorted(set(names) - {"manifest.json"}):
                raise ValueError("Backup manifest does not match its contents.")
            if (
                manifest.get("format") != "FunChessEngine.WorkspaceBundle"
                or manifest.get("version") != 1
            ):
                raise ValueError("Unsupported workspace bundle.")
            metadata = json.loads(archive.read("workspace.json"))
            if not isinstance(metadata, dict):
                raise ValueError("Workspace metadata must be an object.")
            return {"metadata": metadata, "included": names}
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid workspace bundle.") from exc


def restore_bundle(token: str) -> dict[str, Any]:
    inspected = inspect_bundle(token)
    path, _ = uploaded_file(token)
    root = default_data_dir()
    root.mkdir(parents=True, exist_ok=True)
    with LOCK, tempfile.TemporaryDirectory() as staging:
        staged = Path(staging)
        names = [name for name in DATABASES if name in inspected["included"]]
        with zipfile.ZipFile(path) as archive:
            for name in names:
                with archive.open(name) as source, (staged / name).open("wb") as extracted:
                    shutil.copyfileobj(source, extracted, length=1024 * 1024)
                expected_path = staged / f"expected-{name}"
                if name == "library.sqlite3":
                    LibraryDatabase(expected_path).stats()
                else:
                    OpeningBook(expected_path)
                with (
                    closing(sqlite3.connect(expected_path)) as expected,
                    closing(sqlite3.connect(staged / name)) as candidate,
                ):
                    objects = candidate.execute("SELECT name,type FROM sqlite_master").fetchall()
                    tables = {str(n) for n, kind in objects if kind == "table"}
                    if not DATABASES[name] <= tables or any(
                        kind in {"trigger", "view"} for _, kind in objects
                    ):
                        raise ValueError(f"Unsupported database schema in {name}.")
                    optional = (
                        {"game_details", "library_views", "library_settings", "library_undo"}
                        if name == "library.sqlite3"
                        else set()
                    )
                    for table in DATABASES[name] | (optional & tables):
                        if (
                            candidate.execute(f"PRAGMA table_info({table})").fetchall()
                            != expected.execute(f"PRAGMA table_info({table})").fetchall()
                        ):
                            raise ValueError(f"Unsupported columns in {name}: {table}.")
                    if candidate.execute("PRAGMA foreign_key_check").fetchone():
                        raise ValueError(f"Broken database references in {name}.")
                    if candidate.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise ValueError(f"Database integrity check failed for {name}.")
        rollback = []
        try:
            for name in names:
                target = root / name
                existed = target.exists()
                if existed:
                    _snapshot(target, staged / f"old-{name}")
                rollback.append((name, existed))
                _snapshot(staged / name, target)
        except Exception:
            for name, existed in reversed(rollback):
                if existed:
                    _snapshot(staged / f"old-{name}", root / name)
                else:
                    (root / name).unlink(missing_ok=True)
            raise
    return inspected


def import_fingerprint(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def cleanup() -> None:
    shutil.rmtree(_TEMP, ignore_errors=True)


atexit.register(cleanup)
