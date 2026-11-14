#!/usr/bin/env bash
set -euo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME="$BASE/.dsh-home"
TARGET="0.2.2-rc.1"
CLI="$BASE/node_modules/.bin/dsh"
[ -x "$CLI" ] || { echo "ERROR: local CLI missing. Run npm install first." >&2; exit 1; }
NODE_MIN="24.9.0"
NODE_GOT="$(node -p 'process.versions.node')"
[ "$(printf '%s\n' "$NODE_MIN" "$NODE_GOT" | sort -V | head -1)" = "$NODE_MIN" ] || { echo "ERROR: node $NODE_GOT, need >= $NODE_MIN" >&2; exit 1; }
GOT="$("$CLI" --version | tr -d '\r' | head -1)"
[ "$GOT" = "$TARGET" ] || { echo "ERROR: got $GOT, expected $TARGET. Do not fall back." >&2; exit 1; }
exec "$CLI" web "$@"
