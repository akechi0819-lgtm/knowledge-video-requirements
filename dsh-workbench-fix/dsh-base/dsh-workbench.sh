#!/usr/bin/env bash
# 在 macOS/Linux 启动三段工作台。生产任务继承同一进程的配置。
set -euo pipefail
cd "$(dirname "$0")"
export DSH_HOME="${DSH_HOME:-$PWD/.dsh-home}"
# 本机拥有者维护的模型配置，保存在忽略入库的 DSH_HOME。
if [[ -r "$DSH_HOME/workbench-model.env" ]]; then
  set -a
  source "$DSH_HOME/workbench-model.env"
  set +a
fi
cli="${DSH_CLI:-$PWD/node_modules/.bin/dsh}"
if [[ ! -x "$cli" ]]; then cli="$(command -v dsh)"; fi
[[ "$("$cli" --version)" == '0.2.2-rc.1' ]] || { echo '需要 DSH 0.2.2-rc.1' >&2; exit 1; }
plugins="$DSH_HOME/profiles/workbench/node_modules/@bohack"
mkdir -p "$plugins"
if [[ ! -e "$plugins/blueprint" ]]; then ln -s "$PWD/packages/bohack-blueprint" "$plugins/blueprint"; fi
export VIDEO_KIT_DIR="${VIDEO_KIT_DIR:-$(cd ../../video-kit && pwd)}"
if [[ -z "${WORKBENCH_MODEL_ENDPOINT:-}" || -n "${SCENE_ENDPOINT:-}" ]]; then
  export SCENE_ENDPOINT="${SCENE_ENDPOINT:-https://api.deepseek.com/chat/completions}"
  export SCENE_MODEL="${SCENE_MODEL:-deepseek-flash}"
  if [[ -z "${SCENE_API_KEY:-}" && "$SCENE_ENDPOINT" == 'https://api.deepseek.com/chat/completions' ]]; then
    export SCENE_API_KEY="${DEEPSEEK_API_KEY:-}"
    if [[ -z "$SCENE_API_KEY" && -r "$DSH_HOME/.credentials.yaml" ]]; then
      SCENE_API_KEY="$(ruby -ryaml -e 'print YAML.safe_load(File.read(ARGV.fetch(0))).dig("refs","DEEPSEEK_API_KEY")' "$DSH_HOME/.credentials.yaml")"
    fi
  fi
fi
if [[ "$(uname -s)-$(uname -m)" == Darwin-arm64 ]]; then
  for tool in ffmpeg ffprobe; do
    [[ "$tool" == ffmpeg ]] && var=VIDEO_FFMPEG || var=VIDEO_FFPROBE
    installed="$VIDEO_KIT_DIR/node_modules/@${tool}-installer/darwin-arm64/$tool"
    if [[ -z "${!var:-}" && -x "$installed" ]]; then export "$var=$installed"; fi
  done
fi
if [[ -z "${VIDEO_PYTHON:-}" && "$(uname)" == Darwin ]] && python3 -c 'import numpy, PIL' 2>/dev/null; then
  export VIDEO_PYTHON="$(command -v python3)"
fi
if [[ "$(uname)" == Darwin && -z "${VIDEO_VOICE:-}" && -z "${VOICE_NAME:-}" ]]; then export VIDEO_VOICE=say:Tingting; fi
exec "$cli" workbench --port "${WORKBENCH_PORT:-3099}" --no-open "$@"
