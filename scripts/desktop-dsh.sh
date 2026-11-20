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
# Repoint the generated link on every launch because the App can be moved or updated.
mkdir -p "$profile/node_modules/@bohack"
ln -sfn "$base/packages/bohack-blueprint" "$profile/node_modules/@bohack/blueprint"
for name in .agents rules; do
  [[ -e "$workspace/$name" ]] || cp -R "$base/workspace/$name" "$workspace/$name"
done
export JIANGJIE_DESKTOP_WORKSPACE="$workspace"
export BOHACK_DESKTOP_KEYCHAIN_HELPER="$bin/Jiangjie"
plist="$resources/../Info.plist"
export JIANGJIE_MEMBER_URL="${JIANGJIE_MEMBER_URL:-$(/usr/libexec/PlistBuddy -c 'Print :JiangjieMemberURL' "$plist" 2>/dev/null || true)}"
export JIANGJIE_MEMBER_AGENT_API="${JIANGJIE_MEMBER_AGENT_API:-$(/usr/libexec/PlistBuddy -c 'Print :JiangjieMemberAgentAPI' "$plist" 2>/dev/null || true)}"
export JIANGJIE_DESKTOP_AGENT_MARKER=local-desktop-route
export JIANGJIE_DESKTOP_DSH_PATCH="$resources/desktop-agent.patch.yml"
exec "$base/dsh-workbench.sh" --host 127.0.0.1
