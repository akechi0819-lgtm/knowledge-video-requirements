#!/bin/bash
set -euo pipefail
exec 3>&1 1>&2
cd "$(dirname "$0")/.."
root="$PWD"
[[ "$(uname -sm)" == 'Darwin arm64' ]] || { echo '需在 Apple Silicon Mac 上构建。' >&2; exit 1; }
mkdir -p .runtime
stage="$(mktemp -d "${TMPDIR:-/tmp}/jiangjie-desktop-build.XXXXXXXX")"
stage="$(cd "$stage" && pwd -P)"
app="$stage/讲界.app"
resources="$app/Contents/Resources"
runtime="$resources/runtime"
base="$resources/dsh-workbench-fix/dsh-base"
kit="$resources/video-kit"
bin="$app/Contents/MacOS"
helpers="$app/Contents/Helpers"
mkdir -p "$bin" "$helpers" "$runtime/python" "$base" "$kit" "$resources/scripts" "$resources/.agents/skills"
mkdir -p "$resources/startup/media"
cp desktop/startup.html "$resources/startup/index.html"
cp frontend/public/site/media/{projection-hall.webp,m1.jpg,m2.jpg,m3.jpg} "$resources/startup/media/"
cp desktop/Info.plist "$app/Contents/Info.plist"
if [[ -n "${JIANGJIE_MEMBER_URL:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :JiangjieMemberURL string $JIANGJIE_MEMBER_URL" "$app/Contents/Info.plist"
fi
if [[ -n "${JIANGJIE_MEMBER_AGENT_API:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :JiangjieMemberAgentAPI string $JIANGJIE_MEMBER_AGENT_API" "$app/Contents/Info.plist"
fi
xcrun swiftc -O -target arm64-apple-macos14.0 desktop/main.swift -o "$app/Contents/MacOS/Jiangjie"

cache="$root/.runtime/desktop-downloads"
mkdir -p "$cache"
download() {
  local url="$1" expected="$2" target="$cache/$3"
  if [[ ! -f "$target" ]]; then
    /usr/bin/curl --fail --location --silent --show-error "$url" -o "$target.part"
    mv "$target.part" "$target"
  fi
  printf '%s  %s\n' "$expected" "$target" | /usr/bin/shasum -a 256 --check >&2
}

node_archive=node-v24.22.1-darwin-arm64.tar.gz
download "https://nodejs.org/dist/v24.22.1/$node_archive" 89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 "$node_archive"
tar -xzf "$cache/$node_archive" -C "$stage"
node_dist="$stage/${node_archive%.tar.gz}"
cp "$node_dist/bin/node" "$bin/node"
cp "$node_dist/LICENSE" "$runtime/Node-LICENSE.txt"
export PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin"
npm_cli="$node_dist/lib/node_modules/npm/bin/npm-cli.js"

python_archive=cpython-3.12.14+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz
download "https://github.com/astral-sh/python-build-standalone/releases/download/20260901/$python_archive" 81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b "$python_archive"
tar -xzf "$cache/$python_archive" --strip-components=1 -C "$runtime/python"
"$runtime/python/bin/python3" -m pip install --disable-pip-version-check --only-binary=:all: --no-compile -r video-kit/requirements.txt -c desktop/python-constraints.txt

source_base="$root/dsh-workbench-fix/dsh-base"
source_plugin="$source_base/packages/bohack-blueprint"
plugin="$base/packages/bohack-blueprint"
profile=.dsh-home/profiles/workbench
mkdir -p "$base/$profile" "$base/workspace" "$plugin"
for file in package.json cordis.yml cordis.patch.yml; do
  cp "$source_base/$profile/$file" "$base/$profile/$file"
done
cp -R "$source_base/workspace/.agents" "$source_base/workspace/rules" "$base/workspace/"
cp -R "$source_base"/{package.json,package-lock.json,dsh-workbench.sh} "$base/"
plugin_archive="$(node "$npm_cli" pack --silent --pack-destination "$stage" "$source_plugin")"
tar -xzf "$stage/$plugin_archive" --strip-components=1 -C "$plugin"
node --input-type=module -e 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]));' "$plugin/index.js"
cp -R video-kit/{package.json,package-lock.json,WORK,scripts,vendor} "$kit/"
for skill in andy-vibe-knowledge ai-teardown motion-design-prompt-generator vibe-knowledge-film; do
  /usr/bin/rsync -rL --exclude=.git --exclude=.DS_Store --exclude=node_modules --exclude=__pycache__ \
    ".agents/skills/$skill/" "$resources/.agents/skills/$skill/"
done
cp .project-skills/andy-vibe-knowledge/LICENSE "$resources/.agents/skills/andy-vibe-knowledge/"
cp .project-skills/andy-vibe-knowledge/LICENSE "$resources/.agents/skills/ai-teardown/"
cp .project-skills/deepseek-opus-motion-skill/LICENSE "$resources/.agents/skills/motion-design-prompt-generator/"
cp scripts/{desktop-dsh.sh,desktop-runtime.sh} "$resources/scripts/"
cp desktop/agent.patch.yml "$resources/desktop-agent.patch.yml"

node "$npm_cli" ci --prefix "$base" --omit=dev --prefer-offline --no-audit --no-fund
node "$npm_cli" ci --prefix "$kit" --omit=dev --prefer-offline --no-audit --no-fund
browser_archive=chromium-Mac_Arm-1749205.zip
download 'https://storage.googleapis.com/chromium-browser-snapshots/Mac_Arm/1749205/chrome-mac.zip' 73430cb37d5f984f3fe4ac9f12a1ee4ea5f2f90d9feda61b91c7f6efc75b521f "$browser_archive"
ditto -x -k "$cache/$browser_archive" "$stage/browser"
mv "$stage/browser/chrome-mac/Chromium.app" "$helpers/"
cp desktop/Chromium-LICENSE.txt "$runtime/"
"$root/scripts/build-desktop-codecs.sh" "$bin" "$root/.runtime/desktop-codec-cache"
cp -R "$root/.runtime/desktop-codec-cache/licenses" "$runtime/codec-licenses"
find "$resources" \( -name .DS_Store -o -name __pycache__ \) -prune -exec rm -rf {} +
xattr -cr "$app"
"$root/scripts/sign-desktop.sh" "$app"
printf '%s\n' "$app" >&3
