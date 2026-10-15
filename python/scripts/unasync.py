"""Generate the sync client in src/twigg/_sync from the async source in src/twigg/_async.

    uv run python scripts/unasync.py          # write
    uv run python scripts/unasync.py --check  # fail if the generated files are stale

`_support.py` is the exception: it is hand-written in both directories, because it holds what
genuinely differs (sleep, locks, tool concurrency)."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src/twigg/_async"
TARGET = ROOT / "src/twigg/_sync"
HAND_WRITTEN = {"_support.py"}

PLAIN = [
    ("async def ", "def "),
    ("async for ", "for "),
    ("async with ", "with "),
    ("await ", ""),
    ("__aenter__", "__enter__"),
    ("__aexit__", "__exit__"),
    ("__aiter__", "__iter__"),
    ("__anext__", "__next__"),
    ("StopAsyncIteration", "StopIteration"),
    (".aiter_bytes(", ".iter_bytes("),
    (".aclose(", ".close("),
    (".aread(", ".read("),
]


def strip_wrapper(text: str, name: str, replace: str) -> str:
    """Rewrite `name[X]` to `replace` with `{}` standing for X, matching brackets properly."""
    out: list[str] = []
    index = 0
    pattern = re.compile(rf"\b{name}\[")
    while (match := pattern.search(text, index)) is not None:
        out.append(text[index : match.start()])
        depth = 1
        position = match.end()
        while depth:
            depth += {"[": 1, "]": -1}.get(text[position], 0)
            position += 1
        inner = text[match.end() : position - 1]
        out.append(replace.format(strip_wrapper(inner, name, replace)))
        index = position
    out.append(text[index:])
    return "".join(out)


def convert(source: str, filename: str) -> str:
    text = source
    for old, new in PLAIN:
        text = text.replace(old, new)
    text = strip_wrapper(text, "Awaitable", "{}")
    text = re.sub(r"AsyncGenerator\[(.*?), None\]", r"Generator[\1, None, None]", text)
    # Class names: AsyncTwigg -> Twigg, AsyncIterator -> Iterator, httpx.AsyncClient -> Client.
    text = re.sub(r"\bAsync([A-Z])", r"\1", text)
    header = f"# Generated from src/twigg/_async/{filename} by scripts/unasync.py. Do not edit.\n"
    return header + text


def generate(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for path in sorted(SOURCE.glob("*.py")):
        if path.name in HAND_WRITTEN:
            continue
        (target / path.name).write_text(convert(path.read_text(), path.name))
    # Imports the conversion made unused (Awaitable, for one) and the formatting it disturbed.
    files = [str(p) for p in target.glob("*.py") if p.name not in HAND_WRITTEN]
    subprocess.run(["ruff", "check", "--fix", "--quiet", "--select", "F401,I", *files], check=True)
    subprocess.run(["ruff", "format", "--quiet", *files], check=True)


def main() -> int:
    if "--check" not in sys.argv:
        generate(TARGET)
        return 0
    with tempfile.TemporaryDirectory() as scratch:
        temporary = Path(scratch) / "_sync"
        generate(temporary)
        stale = [
            p.name
            for p in sorted(temporary.glob("*.py"))
            if not (TARGET / p.name).exists() or (TARGET / p.name).read_text() != p.read_text()
        ]
    if stale:
        print(f"Stale generated files: {', '.join(stale)}. Run scripts/unasync.py.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
