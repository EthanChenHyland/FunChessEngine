import argparse
import zipfile
from collections.abc import Iterator
from pathlib import Path

from harness.rules import MAX_UNZIPPED_BYTES

DEFAULT_INCLUDES = ("weights",)
SKIP = {"__pycache__", ".DS_Store"}


def members(root: Path, includes: tuple[str, ...]) -> Iterator[tuple[Path, str]]:
    named: set[str] = set()
    agent = root / "agent.py"
    if agent.is_file():
        named.add(agent.name)
        yield agent, agent.name
    for name in includes:
        if name in named:
            continue
        source = root / name
        if source.is_file():
            named.add(name)
            yield source, name
        elif source.is_dir():
            for path in sorted(source.rglob("*")):
                if path.is_file() and not SKIP & set(path.parts):
                    yield path, str(path.relative_to(root))


def build(root: Path, destination: Path, includes: tuple[str, ...]) -> list[str]:
    entries = list(members(root, includes))
    written = [name for _, name in entries]
    if "agent.py" not in written:
        raise SystemExit(
            f"{root / 'agent.py'} does not exist; engine package expects agent.py at root"
        )
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for source, name in entries:
            archive.write(source, name)
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a portable engine package.")
    parser.add_argument("--out", type=Path, default=Path("engine-package.zip"))
    parser.add_argument("--include", action="append", default=[])
    arguments = parser.parse_args()

    includes = DEFAULT_INCLUDES + tuple(arguments.include)
    root = Path.cwd()
    written = build(root, arguments.out, includes)
    size = arguments.out.stat().st_size
    unzipped = sum((root / name).stat().st_size for name in written)
    print(f"{arguments.out} ({size:,} bytes, {unzipped:,} unzipped)")
    for name in written:
        print(f"  {name}")
    if unzipped > MAX_UNZIPPED_BYTES:
        over = unzipped / MAX_UNZIPPED_BYTES
        print(
            f"\nwarning: {unzipped / 1024 / 1024:.1f} MB unzipped is {over:.1f}x the "
            f"{MAX_UNZIPPED_BYTES // 1024 // 1024} MB configured package limit"
        )
        raise SystemExit(2)


if __name__ == "__main__":
    main()
