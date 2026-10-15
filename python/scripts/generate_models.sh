#!/usr/bin/env bash
# Regenerate the pydantic models from the pinned OpenAPI document. Run from python/:
#   ./scripts/generate_models.sh
set -euo pipefail
cd "$(dirname "$0")/.."
uv run datamodel-codegen \
  --input ../spec/openapi.json \
  --input-file-type openapi \
  --output src/twigg/_generated/models.py \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.10 \
  --use-standard-collections \
  --use-union-operator \
  --use-schema-description \
  --use-field-description \
  --field-constraints \
  --enum-field-as-literal all \
  --use-annotated \
  --disable-timestamp \
  --capitalise-enum-members \
  --collapse-root-models \
  --use-double-quotes \
  --extra-fields allow \
  --use-type-alias \
  --formatters ruff-format
# Accept enum values and union variants the API adds later, instead of failing validation.
uv run python scripts/open_models.py src/twigg/_generated/models.py ../spec/openapi.json
uv run ruff format --quiet src/twigg/_generated/models.py
touch src/twigg/_generated/__init__.py
