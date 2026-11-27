#!/bin/bash
set -euo pipefail
umask 077
source "$(dirname "$0")/desktop-runtime.sh"
base="$resources/dsh-workbench-fix/dsh-base"
data="$1"
export DSH_HOME="$data/dsh"
export WORKBENCH_PORT=0
workspace="$data/workspace"
profile="$DSH_HOME/profiles/workbench"
mkdir -p "$profile" "$workspace"
for name in package.json cordis.yml cordis.patch.yml; do
  [[ -e "$profile/$name" ]] || cp "$base/.dsh-home/profiles/workbench/$name" "$profile/$name"
done
# Repoint the bundle on every launch so preset updates reach existing profiles.
# Video presets are defined in the bundle, not the first-launch profile copy.
mkdir -p "$profile/node_modules/@bohack"
ln -sfn "$base/packages/bohack-blueprint" "$profile/node_modules/@bohack/blueprint"
for name in .agents rules; do
  [[ -e "$workspace/$name" ]] || cp -R "$base/workspace/$name" "$workspace/$name"
done
# Older installs copied these bundled rules only on first launch. Upgrade the
# shipped versions while preserving locally edited rules and installed skills.
refresh_blueprint_rule() {
  local relative="$1" target="$workspace/$1" digest
  shift
  if [[ -e "$target" ]]; then
    digest="$(shasum -a 256 < "$target" | cut -d' ' -f1)"
    [[ " $* " == *" $digest "* ]] || return 0
  fi
  mkdir -p "$(dirname "$target")"
  cp "$base/workspace/$relative" "$target"
}
refresh_blueprint_rule rules/blueprint.md \
  81ac3e016afa941a601326ea4be9c2fb0a9a03011c3ce6af13fdbcc8eb93e83e \
  f632f9d9e0e40b6a7e9b768222a629526ab454a1afad28d4f1834695f97bff34 \
  8b9a364dd89c7c1c2ece8971926a78c5525194a3c5d846150b56e299b60d799e
refresh_blueprint_rule .agents/skills/blueprint/SKILL.md \
  16a7ee10d894b058eeed52893f6776eda10eddfe1eea1e7be3902a1842b0efb1 \
  85bb8f78b875a7669312795c003d4ac6c7eca8027e900cf4fc521ec00131dfcf \
  de03f06fedc1af6641e41798661f7deb796e4f444395988a99c07942bf4d1e8c
export JIANGJIE_DESKTOP_WORKSPACE="$workspace"
export BOHACK_DESKTOP_KEYCHAIN_HELPER="$bin/Jiangjie"
plist="$resources/../Info.plist"
export JIANGJIE_MEMBER_URL="${JIANGJIE_MEMBER_URL:-$(/usr/libexec/PlistBuddy -c 'Print :JiangjieMemberURL' "$plist" 2>/dev/null || true)}"
export JIANGJIE_MEMBER_AGENT_API="${JIANGJIE_MEMBER_AGENT_API:-$(/usr/libexec/PlistBuddy -c 'Print :JiangjieMemberAgentAPI' "$plist" 2>/dev/null || true)}"
export JIANGJIE_DESKTOP_AGENT_MARKER=local-desktop-route
export JIANGJIE_DESKTOP_DSH_PATCH="$resources/desktop-agent.patch.yml"
exec "$base/dsh-workbench.sh" --host 127.0.0.1
