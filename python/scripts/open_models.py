"""Open the generated models to values the API adds after this SDK was released.

datamodel-codegen writes closed types: an enum is a `Literal` and a tagged union fails on a tag
it has not seen. Pydantic validates every response, so a new run status or a new history part
type would make a call that worked yesterday raise. This rewrites the generated module so that

- an enum field (a `Literal` of two or more values) also accepts any other string, and
- every discriminated union gets an `Unknown<Union>` variant that keeps whatever arrived, and
- string patterns are dropped. The models only read responses, and the API validated those values
  before storing them. A pattern can also mean something else to pydantic's regex engine than to
  the ECMAScript one OpenAPI uses: `[&--0]` is a range there and a set difference here, which
  rejected every external id containing `+`.

Single-value `Literal`s are left alone: they are the tags that identify a union's variants.

    uv run python scripts/open_models.py src/twigg/_generated/models.py ../spec/openapi.json
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ENUM = re.compile(r'Literal\[\s*"[^"]*"(?:\s*,\s*"[^"]*")+\s*,?\s*\]')
PATTERN = re.compile(r"""\s*pattern=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),?""")
UNION = re.compile(
    r"(?P<variants>(?!None\b)[A-Z]\w*(?:\s*\|\s*(?!None\b)[A-Z]\w*)+)(?P<none>\s*\|\s*None)?\s*,"
    r'\s*Field\(discriminator="(?P<tag>\w+)"\)'
)
HELPERS = '''

def _tagged(field: str, known: tuple[str, ...]) -> Discriminator:
    """Pick a union variant by its tag, falling back to the union's Unknown variant."""

    def pick(value: Any) -> str:
        if value is None:
            return "__none__"
        tag = value.get(field) if isinstance(value, dict) else getattr(value, field, None)
        return tag if tag in known else "__unknown__"

    return Discriminator(pick)
'''
UNKNOWN = '''

class Unknown{name}(BaseModel):
    """A {name} variant this SDK version does not know. Every field the API sent is kept."""

    model_config = ConfigDict(
        extra="allow",
    )
    {tag}: str
'''


def unions(spec: dict[str, object]) -> dict[frozenset[str], tuple[str, str, dict[str, str]]]:
    """Each discriminated union in the spec, keyed by its set of variant schema names."""
    schemas = spec["components"]["schemas"]  # type: ignore[index]
    found: dict[frozenset[str], tuple[str, str, dict[str, str]]] = {}
    for name, schema in schemas.items():  # type: ignore[union-attr]
        discriminator = schema.get("discriminator")
        if not discriminator:
            continue
        by_name = {ref.rsplit("/", 1)[-1]: tag for tag, ref in discriminator["mapping"].items()}
        found[frozenset(by_name)] = (name, discriminator["propertyName"], by_name)
    return found


def rewrite(source: str, spec: dict[str, object]) -> str:
    source = ENUM.sub(lambda m: f"{m.group(0)} | str", source)
    source = PATTERN.sub("", source)
    known = unions(spec)
    needed: dict[str, str] = {}

    def union(match: re.Match[str]) -> str:
        variants = [v.strip() for v in match.group("variants").split("|")]
        entry = known.get(frozenset(variants))
        if entry is None:
            raise SystemExit(f"No union in the spec has the variants {variants}")
        name, tag, by_name = entry
        if tag != match.group("tag"):
            raise SystemExit(f"{name}: generated tag {match.group('tag')!r}, spec says {tag!r}")
        needed[name] = tag
        choices = [f'Annotated[{v}, Tag("{by_name[v]}")]' for v in variants]
        choices.append(f'Annotated[Unknown{name}, Tag("__unknown__")]')
        if match.group("none"):
            choices.append('Annotated[None, Tag("__none__")]')
        tags = ", ".join(f'"{by_name[v]}"' for v in variants)
        return f'{" | ".join(choices)}, _tagged("{tag}", ({tags},))'

    source = UNION.sub(union, source)
    if "Field(discriminator=" in source:
        raise SystemExit("A discriminated union was left closed; extend scripts/open_models.py")
    source = source.replace("from pydantic import ", "from pydantic import Discriminator, Tag, ", 1)
    # Helpers and Unknown variants go straight after the imports, before anything uses them.
    first_class = source.index("\nclass ")
    extra = HELPERS + "".join(UNKNOWN.format(name=n, tag=t) for n, t in sorted(needed.items()))
    return source[:first_class] + extra + source[first_class:]


def main() -> None:
    models, spec = Path(sys.argv[1]), Path(sys.argv[2])
    models.write_text(rewrite(models.read_text(), json.loads(spec.read_text())))


if __name__ == "__main__":
    main()
