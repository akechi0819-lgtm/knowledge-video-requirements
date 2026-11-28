#!/usr/bin/env bash
set -euo pipefail

page="$1"
site="$2"

# Check the links visitors actually see in the static page.
links="$(grep -oE 'href="/downloads/[A-Za-z0-9._/-]+\.(dmg|exe)"' "$page" | cut -d '"' -f 2)"
dmg_count="$(printf '%s\n' "$links" | awk '/\.dmg$/ {count++} END {print count+0}')"
exe_count="$(printf '%s\n' "$links" | awk '/\.exe$/ {count++} END {print count+0}')"
if [[ "$dmg_count" != 1 || "$exe_count" != 1 ]]; then
  echo 'Expected exactly one macOS DMG link and one Windows EXE link.' >&2
  exit 1
fi

while IFS= read -r link; do
  status="$(curl -fsS --max-time 20 --range 0-1023 --max-filesize 1024 \
    --output /dev/null --write-out '%{http_code}' "$site$link")"
  if [[ "$status" != 206 ]]; then
    echo "Installer did not return HTTP 206: $site$link (HTTP $status)" >&2
    exit 1
  fi
  echo "HTTP 206 $site$link"
done <<< "$links"
