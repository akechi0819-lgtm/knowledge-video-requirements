#Requires -Version 7.2
# Thin wrapper aligned with docs/win-release-spec.md §5 path `scripts/sign-win-desktop.ps1`.
& (Join-Path $PSScriptRoot 'windows/sign.ps1') @args
exit $LASTEXITCODE
