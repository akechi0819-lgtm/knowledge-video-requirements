#!/bin/sh
set -eu
workspace="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$workspace"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"
exec dsh --profile web --patch "$workspace/dsh/requirement-dialogue.patch.yml" "$@"
