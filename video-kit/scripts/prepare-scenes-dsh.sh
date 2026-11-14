#!/bin/sh
set -eu
kit_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export DSH_HOME="${DSH_HOME:-$kit_dir/../dsh-workbench-fix/dsh-base/.dsh-home}"
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -r "$DSH_HOME/.credentials.yaml" ]; then
  DEEPSEEK_API_KEY="$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV.fetch(0))).dig("refs", "DEEPSEEK_API_KEY")' "$DSH_HOME/.credentials.yaml")"
  export DEEPSEEK_API_KEY
fi
exec node "$kit_dir/scripts/prepare-scenes.mjs" "$@" --dsh
