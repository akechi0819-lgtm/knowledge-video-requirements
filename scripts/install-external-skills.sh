#!/bin/bash
set -euo pipefail

# Download directly from the original publishers into the user's workspace.
workspace="${JIANGJIE_DESKTOP_WORKSPACE:-${JIANGJIE_DESKTOP_DATA:-$HOME/Library/Application Support/讲界}/workspace}"
skills="$workspace/.agents/skills"
mkdir -p "$skills"
install_skill() {
  local name="$1" url="$2" revision="$3" target="$skills/$1"
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$(git -C "$target" rev-parse HEAD 2>/dev/null || true)" == "$revision" ]] && [[ -z "$(git -C "$target" status --porcelain 2>/dev/null)" ]]; then
      echo "已安装固定版本：$target"
      return
    fi
    echo "目录已存在但不是未修改的固定版本，请自行检查：$target" >&2
    return 1
  fi
  local temp
  temp="$(mktemp -d "$skills/.${name}.XXXXXXXX")"
  if ! git -C "$temp" init -q || ! git -C "$temp" fetch -q --depth 1 "$url" "$revision" || ! git -C "$temp" checkout -q --detach FETCH_HEAD; then
    rm -rf "$temp"
    echo "安装失败：$name" >&2
    return 1
  fi
  mv "$temp" "$target"
  echo "已安装：$target"
}
install_skill vibe-knowledge-film https://github.com/HeyChengC/vibe-knowledge-film.git 62d51508aad00003dc6209afa80c4b5dc540de59
install_skill vibe-know--skill https://github.com/zhaosenlin12-creator/vibe-know--skill.git 74cd27291a1e1c1725f5c58867313d69f044cd67
