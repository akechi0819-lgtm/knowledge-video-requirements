#Requires -Version 7.2
<#
.SYNOPSIS
    构建讲界视频工坊 Windows x64 双轨安装包（轻量在线引导安装器 + 离线完整安装包）、组件增量包与更新清单。
.DESCRIPTION
    全流程遵循：
    1. 严禁使用 UPX 等易触发杀软误报的加壳工具；
    2. 校验轻量在线引导安装器 Jiangjie-Setup-Online-x64.exe 体积 <= 10 MiB；
    3. 按“先内后外”顺序调用 scripts/windows/sign.ps1 签名自有 PE、卸载器与外层安装器；
    4. 生成组件级增量归档、.blockmap、releases.win.json、feed.json、latest.yml/beta.yml 与官网 release-manifest.json。
#>
[CmdletBinding()]
param(
    [string]$StageDirectory,
    [string]$NativeBuildDirectory,
    [string]$OutputDirectory,
    [string]$Version = '0.2.1',
    [int]$ReleaseSequence = 2,
    [ValidateSet('stable', 'beta')]
    [string]$Channel = 'stable',
    [ValidateRange(0, 100)]
    [int]$RolloutPercentage = 100,
    [string]$BaseUrl = 'https://jiangjie.gingers.cloud/downloads',
    [string]$PreviousManifest,
    [string]$MacDmgPath,
    [string]$MacVersion,
    [string]$MacUrl,
    [string]$CodecSourceArchive,
    [string]$SigningPrivateKeyPem = $env:JIANGJIE_FEED_SIGNING_KEY_PEM,
    [string]$SigningKeyId = $(if ($env:JIANGJIE_FEED_KEY_ID) { $env:JIANGJIE_FEED_KEY_ID } else { 'jiangjie-release-2026' }),
    [string]$SignMode = $(if ($env:WIN_SIGN_MODE) { $env:WIN_SIGN_MODE } else { 'none' }),
    [switch]$ValidateOnly,
    [switch]$SkipComponents,
    [switch]$AllowMissingMakensis
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Windows packaging requires Windows x64.' }

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $StageDirectory) { $StageDirectory = Join-Path $repo 'build/win-desktop' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo "build/win-release/$Channel/$ReleaseSequence" }
$StageDirectory = [IO.Path]::GetFullPath($StageDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$nsiScript = Join-Path $repo 'desktop/windows/release/installer.nsi'
$signScript = Join-Path $PSScriptRoot 'sign.ps1'
$manifestGen = Join-Path $PSScriptRoot 'generate-release-manifest.mjs'

function Resolve-Makensis {
    $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
        'C:\Program Files (x86)\NSIS\makensis.exe',
        'C:\Program Files\NSIS\makensis.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\NSIS\makensis.exe')
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

function Resolve-OnlineBootstrapper([string]$NativeDir, [string]$StageDir) {
    $candidates = @()
    if ($NativeDir) {
        $candidates += (Join-Path $NativeDir 'Jiangjie-Setup-Online-x64.exe')
        $candidates += (Join-Path $NativeDir 'Release/Jiangjie-Setup-Online-x64.exe')
    }
    $candidates += (Join-Path $StageDir 'Jiangjie-Setup-Online-x64.exe')
    $desktopCache = Join-Path $repo '.runtime/windows-desktop'
    if (Test-Path -LiteralPath $desktopCache -PathType Container) {
        foreach ($dir in (Get-ChildItem -LiteralPath $desktopCache -Directory -Filter 'native-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
            $candidates += (Join-Path $dir.FullName 'Release/Jiangjie-Setup-Online-x64.exe')
            $candidates += (Join-Path $dir.FullName 'Jiangjie-Setup-Online-x64.exe')
        }
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return [IO.Path]::GetFullPath($c) }
    }
    return $null
}

function Assert-NoUpx([string]$FilePath) {
    $bytes = [IO.File]::ReadAllBytes($FilePath)
    $ascii = [Text.Encoding]::ASCII.GetString($bytes, 0, [Math]::Min($bytes.Length, 4096))
    foreach ($marker in @('UPX0', 'UPX1', 'UPX!')) {
        if ($ascii.Contains($marker)) {
            throw "Forbidden UPX packer marker ($marker) detected in $FilePath"
        }
    }
}

Write-Host "[package] Version=$Version Seq=$ReleaseSequence Channel=$Channel Rollout=$RolloutPercentage% SignMode=$SignMode"
if (-not (Test-Path -LiteralPath $nsiScript -PathType Leaf)) { throw "Missing NSIS script: $nsiScript" }
if (-not (Test-Path -LiteralPath $signScript -PathType Leaf)) { throw "Missing sign script: $signScript" }
if (-not (Test-Path -LiteralPath $manifestGen -PathType Leaf)) { throw "Missing manifest generator: $manifestGen" }

if ($ValidateOnly) {
    Write-Host '[package] Running syntax & layout validation only...'
    $nsiContent = Get-Content -LiteralPath $nsiScript -Raw
    foreach ($required in @(
        'Unicode True',
        'RequestExecutionLevel user',
        'HKCU "${UNINSTALL_REG_KEY}"',
        '$LOCALAPPDATA\Programs\${APP_ID}',
        '$APPDATA\${APP_ID}',
        'Jiangjie.exe'
    )) {
        if (-not $nsiContent.Contains($required)) { throw "NSIS script missing required directive: $required" }
    }
    if ($nsiContent -match '\bUPX\b' -and $nsiContent -notmatch '严禁使用 UPX') {
        throw 'NSIS script must not invoke UPX'
    }
    $makensis = Resolve-Makensis
    if ($makensis) {
        Write-Host "[package] Found makensis: $makensis"
    } else {
        Write-Warning '[package] makensis.exe not installed on this host (install NSIS 3.x to compile offline .exe).'
    }
    Write-Host '[package] Validation passed.'
    return
}

if (-not (Test-Path -LiteralPath $StageDirectory -PathType Container)) {
    throw "Desktop staging directory not found: $StageDirectory. Run scripts/build-win-desktop.ps1 first."
}

$null = New-Item -ItemType Directory -Force $OutputDirectory
$componentsDir = Join-Path $OutputDirectory 'components'
$null = New-Item -ItemType Directory -Force $componentsDir

# 1. Copy & validate lightweight online bootstrapper (must be <= 10 MiB and free of UPX)
$onlineSrc = Resolve-OnlineBootstrapper $NativeBuildDirectory $StageDirectory
if (-not $onlineSrc) { throw 'Jiangjie-Setup-Online-x64.exe not found. Build desktop/windows with CMake first.' }
$onlineOut = Join-Path $OutputDirectory 'Jiangjie-Setup-Online-x64.exe'
Copy-Item -LiteralPath $onlineSrc -Destination $onlineOut -Force
$onlineSize = (Get-Item -LiteralPath $onlineOut).Length
if ($onlineSize -gt (10 * 1024 * 1024)) {
    throw "Online bootstrapper exceeds 10 MiB limit: $onlineSize bytes"
}
Assert-NoUpx $onlineOut
Write-Host ("[package] Online bootstrapper ready: {0:N2} MiB ({1} bytes)" -f ($onlineSize / 1MB), $onlineSize)

# 2. Sign inner native executables BEFORE building component archives & offline installer
$innerBinaries = @(
    (Join-Path $StageDirectory 'Jiangjie.exe'),
    (Join-Path $StageDirectory 'JiangjieApp.exe'),
    (Join-Path $StageDirectory 'JiangjieUpdater.exe'),
    (Join-Path $StageDirectory 'BohackCredentialStore.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }

if ($innerBinaries.Count -eq 0) { throw "No native executables found in $StageDirectory" }
Write-Host "[package] Signing $($innerBinaries.Count) inner binaries (mode=$SignMode)..."
& $signScript -Files $innerBinaries -Mode $SignMode -ReportPath (Join-Path $OutputDirectory 'sign-inner-report.json')
if ($LASTEXITCODE -ne 0) { throw "Inner binary signing failed with exit code $LASTEXITCODE" }

# 3. Build reproducible component archives (app, node, python, webview2, chromium, codecs, skills, notices)
$nodeExe = Join-Path $StageDirectory 'runtime/node/node.exe'
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { $nodeExe = 'node.exe' }

$componentHashesFile = Join-Path $OutputDirectory 'component-hashes.json'
if (-not $SkipComponents) {
    Write-Host '[package] Building component incremental archives...'
    $compArgs = @(
        $manifestGen, 'build-components',
        '--stage', $StageDirectory,
        '--out-dir', $componentsDir,
        '--hashes-out', $componentHashesFile
    )
    & $nodeExe @compArgs
    if ($LASTEXITCODE -ne 0) { throw "Component packaging failed with exit code $LASTEXITCODE" }
}

# 4. Compile offline NSIS installer (with two-pass signed uninstaller when signing is enabled)
$offlineOut = Join-Path $OutputDirectory 'Jiangjie-Setup-Offline-x64.exe'
$makensis = Resolve-Makensis
if (-not $makensis) {
    if ($AllowMissingMakensis) {
        Write-Warning '[package] makensis.exe is not installed; skipping offline NSIS compilation (-AllowMissingMakensis).'
    } else {
        throw 'makensis.exe (NSIS 3.x Unicode) is required to build Jiangjie-Setup-Offline-x64.exe. Install NSIS 3.x or pass -AllowMissingMakensis.'
    }
} else {
    $viVersion = if ($Version -match '^(\d+\.\d+\.\d+)') { "$($Matches[1]).0" } else { '0.0.0.0' }
    $commonDefs = @(
        '/V3',
        "/DAPP_VERSION=$Version",
        "/DAPP_VI_VERSION=$viVersion",
        "/DRELEASE_SEQUENCE=$ReleaseSequence",
        "/DRELEASE_CHANNEL=$Channel",
        "/DSTAGE_DIR=$StageDirectory",
        "/DOUT_FILE=$offlineOut"
    )
    if (Test-Path -LiteralPath $componentHashesFile -PathType Leaf) {
        $commonDefs += "/DCOMPONENT_HASHES_FILE=$componentHashesFile"
    }

    $prebuiltUninst = $null
    if ($SignMode -ne 'none') {
        Write-Host '[package] Two-pass NSIS build: generating & signing Uninstall.exe...'
        $uninstGen = Join-Path $OutputDirectory '.gen-uninstaller.exe'
        $uninstExe = Join-Path $OutputDirectory '.signed-Uninstall.exe'
        & $makensis @($commonDefs + @('/DGENERATE_UNINSTALLER_ONLY=1', "/DUNINSTALLER_GENERATOR_EXE=$uninstGen", "/DUNINSTALLER_OUTPUT_PATH=$uninstExe", $nsiScript))
        if ($LASTEXITCODE -ne 0) { throw "NSIS uninstaller generation failed ($LASTEXITCODE)" }
        & $uninstGen /S
        if (-not (Test-Path -LiteralPath $uninstExe -PathType Leaf)) { throw 'Failed to emit Uninstall.exe' }
        & $signScript -Files @($uninstExe) -Mode $SignMode -ReportPath (Join-Path $OutputDirectory 'sign-uninstaller-report.json')
        if ($LASTEXITCODE -ne 0) { throw "Uninstaller signing failed ($LASTEXITCODE)" }
        Remove-Item -LiteralPath $uninstGen -Force -ErrorAction SilentlyContinue
        $prebuiltUninst = $uninstExe
    }

    Write-Host '[package] Compiling Jiangjie-Setup-Offline-x64.exe...'
    $buildDefs = @($commonDefs)
    if ($prebuiltUninst) { $buildDefs += "/DPREBUILT_UNINSTALLER=$prebuiltUninst" }
    & $makensis @($buildDefs + @($nsiScript))
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }
    if ($prebuiltUninst) { Remove-Item -LiteralPath $prebuiltUninst -Force -ErrorAction SilentlyContinue }
    Assert-NoUpx $offlineOut
}

# 5. Sign outer installers AFTER compilation (and BEFORE manifest hashing!)
$outerBinaries = @($onlineOut)
if (Test-Path -LiteralPath $offlineOut -PathType Leaf) { $outerBinaries += $offlineOut }
Write-Host "[package] Signing $($outerBinaries.Count) outer installer(s) (mode=$SignMode)..."
& $signScript -Files $outerBinaries -Mode $SignMode -ReportPath (Join-Path $OutputDirectory 'sign-outer-report.json')
if ($LASTEXITCODE -ne 0) { throw "Outer installer signing failed with exit code $LASTEXITCODE" }

# 6. Generate release manifests (.blockmap, releases.win.json, feed.json, latest.yml/beta.yml, release-manifest.json)
Write-Host '[package] Generating release manifests, blockmaps, and checksums...'
$genArgs = @(
    $manifestGen, 'generate',
    '--version', $Version,
    '--sequence', "$ReleaseSequence",
    '--channel', $Channel,
    '--rollout', "$RolloutPercentage",
    '--base-url', $BaseUrl,
    '--out-dir', $OutputDirectory,
    '--online', $onlineOut
)
if (Test-Path -LiteralPath $offlineOut -PathType Leaf) { $genArgs += @('--offline', $offlineOut) }
if (Test-Path -LiteralPath (Join-Path $componentsDir 'components-index.json') -PathType Leaf) {
    $genArgs += @('--components-index', (Join-Path $componentsDir 'components-index.json'))
}
if ($PreviousManifest) { $genArgs += @('--previous-manifest', $PreviousManifest) }
if ($MacDmgPath) { $genArgs += @('--mac-dmg', $MacDmgPath) }
if ($MacVersion) { $genArgs += @('--mac-version', $MacVersion) }
if ($MacUrl) { $genArgs += @('--mac-url', $MacUrl) }
if ($CodecSourceArchive) { $genArgs += @('--codec-source', $CodecSourceArchive) }
if ($SigningPrivateKeyPem) { $genArgs += @('--signing-key', $SigningPrivateKeyPem, '--key-id', $SigningKeyId) }

& $nodeExe @genArgs
if ($LASTEXITCODE -ne 0) { throw "Release manifest generation failed ($LASTEXITCODE)" }

Write-Host "[package] Dual-track release artifacts written to: $OutputDirectory"
