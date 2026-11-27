#Requires -Version 7.2
# Thin wrapper aligned with docs/win-release-spec.md §5 path `scripts/package-win-desktop.ps1`.
& (Join-Path $PSScriptRoot 'windows/package-installer.ps1') @args
exit $LASTEXITCODE
