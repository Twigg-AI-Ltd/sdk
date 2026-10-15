#!/usr/bin/env bash
# Walk through the CLI against examples/cli: bash examples/cli/run.sh, with TWIGG_API_KEY set.
set -euo pipefail
cd "$(dirname "$0")"
twigg() { npx --yes @twigg/cli "$@"; }

echo "== validate (offline)";     twigg config validate -c twigg.config.yaml
echo "== plan";                   twigg config plan -c twigg.config.yaml --scope examples/cli
echo "== apply";                  twigg config apply -c twigg.config.yaml --scope examples/cli --yes
echo "== plan again (no changes)"; twigg config plan -c twigg.config.yaml --scope examples/cli
echo "== resolve";                twigg config resolve --scope examples/cli
echo "== history";                twigg config history --scope examples/cli --surface instructions
echo "== teardown";               twigg config apply -c twigg.teardown.yaml --scope examples/cli --yes
