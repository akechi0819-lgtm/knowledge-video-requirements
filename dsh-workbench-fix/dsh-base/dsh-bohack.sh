#!/usr/bin/env bash
# BoHack A: boot the `bohack` profile (web composition + @bohack/blueprint)
# with the temporary /bohack UI. cwd is pinned to this base so the relative
# `workspace` path in cordis.patch.yml resolves deterministically.
set -euo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE"
exec ./dsh.sh bohack "$@"
