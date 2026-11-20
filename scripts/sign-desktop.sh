#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || ! -d "$1/Contents" ]]; then
  printf 'Usage: %s /path/to/讲界.app\n' "$0" >&2
  exit 2
fi
app="${1%/}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
entitlements="$script_dir/../desktop/runtime-entitlements.plist"
identity="${JIANGJIE_SIGN_IDENTITY:--}"
manifest="$(mktemp -d)"
trap 'rm -rf "$manifest"' EXIT
find "$app/Contents" -type f \
  \( -perm -0100 -o -perm -0010 -o -perm -0001 -o -name '*.node' -o -name '*.so' -o -name '*.dylib' \) -print0 > "$manifest/files"
find "$app/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0 > "$manifest/bundles"
options=(--force --sign "$identity" --options runtime)
if [[ "$identity" != "-" ]]; then
  options+=(--timestamp)
fi

# Electron-style nested apps and command-line runtimes have independent signatures.
# Node and Chromium use JIT. The standalone Python loads extension modules.
while IFS= read -r -d '' path; do
  description="$(file -b "$path")"
  if [[ "$description" == *Mach-O* ]]; then
    case "$path" in
      */MacOS/node|*/runtime/python/bin/python3.*)
        codesign "${options[@]}" --entitlements "$entitlements" "$path" ;;
      *) codesign "${options[@]}" "$path" ;;
    esac
  fi
done < "$manifest/files"

while IFS= read -r -d '' bundle; do
  case "$bundle" in
    */Chromium.app|*/Chromium\ Helper*.app)
      codesign "${options[@]}" --entitlements "$entitlements" "$bundle" ;;
    *) codesign "${options[@]}" "$bundle" ;;
  esac
done < "$manifest/bundles"

codesign "${options[@]}" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
while IFS= read -r -d '' path; do
  description="$(file -b "$path")"
  if [[ "$description" == *Mach-O* ]]; then
    codesign --verify --strict "$path"
  fi
done < "$manifest/files"
