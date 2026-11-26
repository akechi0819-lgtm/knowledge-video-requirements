
#Requires -Version 7.2
[CmdletBinding()]
param(
    [switch]$CompileOnly,
    [string]$Generator = 'Visual Studio 17 2022',
    [string]$WebView2SdkArchive,
    [string]$BrowserLock,
    [string]$RuntimeDirectory,
    [string]$StageDirectory,
    [string]$AppVersion = '0.2.1',
    [int]$ReleaseSequence = 2,
    [ValidateSet('stable', 'beta')]
    [string]$UpdateChannel = 'stable',
    [string]$UpdateFeedUrl = '',
    [string]$ReleasePubKeyB64 = $(if ($env:JIANGJIE_RELEASE_PUBKEY_B64) { $env:JIANGJIE_RELEASE_PUBKEY_B64 } else { '' }),
    [string]$MemberUrl = $(if ($env:JIANGJIE_MEMBER_URL) { $env:JIANGJIE_MEMBER_URL } else { 'https://jiangjie.gingers.cloud/desktop-membership' }),
    [ValidateSet('', 'openai-completions', 'openai-responses')]
    [string]$MemberAgentApi = $env:JIANGJIE_MEMBER_AGENT_API
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'The desktop build requires Windows x64 and MSVC.' }

$repo = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $repo '.runtime/windows-desktop'
$null = New-Item -ItemType Directory -Force $cache
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $repo 'build/win-runtime' }
if (-not $StageDirectory) { $StageDirectory = Join-Path $repo 'build/win-desktop' }
$StageDirectory = [IO.Path]::GetFullPath($StageDirectory)
$version = '1.0.4370.26'
$sdkChecksum = '1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4'

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
function Assert-Checksum([string]$Archive, [string]$Hash) {
    if ($Hash -notmatch '^[0-9a-fA-F]{64}$' -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Hash) {
        throw "SHA-256 verification failed for $Archive"
    }
}
function Get-CachedArchive([string]$Url, [string]$Archive, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
        if ($Url -notmatch '^https://') { throw "Missing local archive $Archive" }
        $download = "$Archive.$([guid]::NewGuid()).download"
        try {
            Invoke-WebRequest -Uri $Url -OutFile $download -TimeoutSec 600
            Assert-Checksum $download $Hash
            Move-Item -LiteralPath $download -Destination $Archive
        } finally {
            if (Test-Path -LiteralPath $download -PathType Leaf) { Remove-Item -LiteralPath $download -Force }
        }
    }
    Assert-Checksum $Archive $Hash
    return $Archive
}
function Copy-Tree([string]$Source, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Missing staging source $Source" }
    & robocopy.exe $Source $Target /E /XJ /MT:16 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XD .git __pycache__ .venv /XF .git .DS_Store .env .env.* '*.pyc'
    if ($LASTEXITCODE -ge 8) { throw "Failed to stage $Source ($LASTEXITCODE)" }
}

if (-not $WebView2SdkArchive) {
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
    $WebView2SdkArchive = Get-CachedArchive $url (Join-Path $cache "microsoft.web.webview2.$version.zip") $sdkChecksum
} else {
    Assert-Checksum $WebView2SdkArchive $sdkChecksum
}
$sdk = Join-Path $cache "sdk-$version"
$null = New-Item -ItemType Directory -Force $sdk
Invoke-Checked tar.exe @('-xf', $WebView2SdkArchive, '-C', $sdk)

$native = Join-Path $cache ('native-' + ($Generator -replace '[^A-Za-z0-9]+', '-'))
$effectiveFeedUrl = if ($UpdateFeedUrl) { $UpdateFeedUrl } else { "https://jiangjie.gingers.cloud/downloads/windows/x64/$UpdateChannel/feed.json" }
$cmakeArgs = @('-S', (Join-Path $repo 'desktop/windows'), '-B', $native, '-G', $Generator,
    "-DWEBVIEW2_SDK=$sdk", "-DJIANGJIE_MEMBER_URL=$MemberUrl", "-DJIANGJIE_MEMBER_AGENT_API=$MemberAgentApi",
    "-DJIANGJIE_APP_VERSION=$AppVersion", "-DJIANGJIE_RELEASE_SEQUENCE=$ReleaseSequence",
    "-DJIANGJIE_UPDATE_CHANNEL=$UpdateChannel", "-DJIANGJIE_UPDATE_FEED_URL=$effectiveFeedUrl",
    "-DJIANGJIE_RELEASE_PUBKEY_B64=$ReleasePubKeyB64",
    '-DBUILD_TESTING=ON', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_TRY_COMPILE_CONFIGURATION=Release')
if ($Generator -like 'Visual Studio*') { $cmakeArgs += @('-A', 'x64') }
Invoke-Checked cmake $cmakeArgs
Invoke-Checked cmake @('--build', $native, '--config', 'Release', '--parallel')
Invoke-Checked ctest @('--test-dir', $native, '-C', 'Release', '--output-on-failure')

$node = Join-Path $RuntimeDirectory 'runtime/node/node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { $node = 'node.exe' }
Invoke-Checked $node @('--test', (Join-Path $repo 'desktop/windows/diagnostics.test.mjs'))
if ($CompileOnly) { return }

if (-not $BrowserLock) { $BrowserLock = Join-Path $PSScriptRoot 'windows/browser-lock.json' }
if (Test-Path -LiteralPath $StageDirectory) { throw "Desktop staging already exists: $StageDirectory" }
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'runtime-bom.json') -PathType Leaf)) { throw 'Run scripts/windows/bundle-runtime.ps1 first.' }
$browserLockPath = (Resolve-Path -LiteralPath $BrowserLock).Path
$browsers = Get-Content -LiteralPath $browserLockPath -Raw | ConvertFrom-Json -AsHashtable
if ($browsers.schemaVersion -ne 1) { throw 'Unsupported browser lock schema.' }

$parent = Split-Path -Parent $StageDirectory
$null = New-Item -ItemType Directory -Force $parent
$stage = Join-Path $parent ('.win-desktop-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $stage
try {
    Copy-Tree $RuntimeDirectory $stage
    # Prune unused Chrome DevTools Markdown issue descriptions (up to 201-char relative paths)
    # that would otherwise exceed Windows 260-char MAX_PATH under %LOCALAPPDATA%\Programs\Jiangjie\versions\<seq>\.
    $longInspectorDocs = Join-Path $stage 'dsh-workbench-fix/dsh-base/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/devtools/models/issues_manager/descriptions'
    if (Test-Path -LiteralPath $longInspectorDocs -PathType Container) {
        Get-ChildItem -LiteralPath $longInspectorDocs -Recurse -Force | ForEach-Object { if (-not $_.PSIsContainer) { $_.IsReadOnly = $false } }
        Remove-Item -LiteralPath $longInspectorDocs -Recurse -Force
    }
    Invoke-Checked cmake @('--install', $native, '--config', 'Release', '--prefix', $stage)

    $base = 'dsh-workbench-fix/dsh-base'
    foreach ($relative in @("$base/packages/bohack-blueprint/lib", "$base/packages/bohack-blueprint/web",
        "$base/packages/bohack-blueprint/scripts", "$base/packages/bohack-blueprint/vendor",
        "$base/workspace/.agents", "$base/workspace/rules",
        'video-kit/WORK', 'video-kit/scripts', 'video-kit/skill-packages', 'video-kit/vendor')) {
        Copy-Tree (Join-Path $repo $relative) (Join-Path $stage $relative)
    }
    foreach ($relative in @("$base/start-dsh.mjs", "$base/packages/bohack-blueprint/index.js", "$base/packages/bohack-blueprint/cordis.patch.yml",
        "$base/packages/bohack-blueprint/package.json", 'video-kit/package.json', 'video-kit/examples/hotpot.v1.json', 'desktop/windows/dsh-shutdown.mjs',
        'desktop/windows/diagnostics.mjs', 'desktop/windows/diagnostics-zip.mjs')) {
        $destination = Join-Path $stage $relative
        $null = New-Item -ItemType Directory -Force (Split-Path -Parent $destination)
        Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination
    }
    $stagedNode = Join-Path $stage 'runtime/node/node.exe'
    $importCheck = 'import { pathToFileURL } from "node:url"; for (const file of process.argv.slice(1)) await import(pathToFileURL(file).href);'
    Invoke-Checked $stagedNode @('--input-type=module', '-e', $importCheck,
        (Join-Path $stage "$base/packages/bohack-blueprint/index.js"),
        (Join-Path $stage "$base/packages/bohack-blueprint/lib/windows-credentials.js"),
        (Join-Path $stage "$base/packages/bohack-blueprint/lib/skill-process.js"))
    foreach ($profile in @('workbench', 'bohack')) {
        $relative = "$base/.dsh-home/profiles/$profile"
        $null = New-Item -ItemType Directory -Force (Join-Path $stage $relative)
        foreach ($name in @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml')) {
            Copy-Item -LiteralPath (Join-Path $repo "$relative/$name") -Destination (Join-Path $stage "$relative/$name")
        }
    }
    $agentPatch = Join-Path $repo 'desktop/agent.patch.yml'
    if (Test-Path -LiteralPath $agentPatch -PathType Leaf) {
        Copy-Item -LiteralPath $agentPatch -Destination (Join-Path $stage 'desktop-agent.patch.yml')
    } else {
        Invoke-Checked git @('-C', $repo, 'show', 'HEAD:desktop/agent.patch.yml') |
            Set-Content -LiteralPath (Join-Path $stage 'desktop-agent.patch.yml') -Encoding utf8
    }
    # The packaged desktop uses its own DPAPI settings and membership provider.
    Add-Content -LiteralPath (Join-Path $stage 'desktop-agent.patch.yml') -Encoding utf8 -Value @(
        '', '- id: credentials', "  name: '@bohack/blueprint/windows-credentials'", '- id: deepseek-account', '  disabled: true'
    )

    $browserBom = [ordered]@{}
    foreach ($id in @('webview2', 'chromium')) {
        $asset = $browsers[$id]
        if (-not $asset -or $asset.version -notmatch '^[0-9]+(\.[0-9]+){0,3}$') { throw "Invalid browser lock entry $id" }
        if ($asset.Contains('url')) {
            if ($asset.archive -ne [IO.Path]::GetFileName($asset.archive)) { throw "Invalid cache name for $id" }
            $archive = Get-CachedArchive $asset.url (Join-Path $cache $asset.archive) $asset.sha256
        } else {
            $archive = [IO.Path]::GetFullPath($asset.archive, (Split-Path -Parent $browserLockPath))
            Assert-Checksum $archive $asset.sha256
        }
        $expanded = Join-Path $stage "unpack-$id"
        $null = New-Item -ItemType Directory $expanded
        if ($id -eq 'webview2') {
            Invoke-Checked expand.exe @('-F:*', $archive, $expanded) | Out-Null
            $program = 'msedgewebview2.exe'
        } else {
            Invoke-Checked tar.exe @('-xf', $archive, '-C', $expanded)
            $program = 'chrome.exe'
        }
        $found = @(Get-ChildItem -LiteralPath $expanded -Recurse -Filter $program -File)
        if ($found.Count -ne 1) { throw "Unexpected $id archive layout." }
        $fileVersion = $found[0].VersionInfo.ProductVersion
        if ($fileVersion -ne $asset.version) { throw "Fixed $id version does not match the lock: $fileVersion" }
        $target = Join-Path $stage "runtime/$id"
        if ($found[0].Directory.FullName -eq $expanded) { Move-Item -LiteralPath $expanded -Destination $target }
        else {
            Move-Item -LiteralPath $found[0].Directory.FullName -Destination $target
            [IO.Directory]::Delete($expanded, $true)
        }
        $browserBom[$id] = [ordered]@{ version = $asset.version; archive = $asset.archive; sha256 = $asset.sha256.ToLowerInvariant() }
        if ($asset.Contains('revision')) { $browserBom[$id].revision = $asset.revision }
        if ($asset.Contains('url')) { $browserBom[$id].url = $asset.url }
    }
    $license = Join-Path $repo 'desktop/Chromium-LICENSE.txt'
    $licenseDestination = Join-Path $stage 'runtime/chromium/Chromium-LICENSE.txt'
    if (Test-Path -LiteralPath $license -PathType Leaf) {
        Copy-Item -LiteralPath $license -Destination $licenseDestination
    } else {
        Invoke-Checked git @('-C', $repo, 'show', 'HEAD:desktop/Chromium-LICENSE.txt') | Set-Content -LiteralPath $licenseDestination -Encoding utf8
    }
    $bom = Join-Path $stage 'runtime-bom.json'
    $data = Get-Content -LiteralPath $bom -Raw | ConvertFrom-Json -AsHashtable
    $data['desktop'] = [ordered]@{ webview2Sdk = $version; webview2SdkSha256 = $sdkChecksum; browsers = $browserBom }
    (Get-Item -LiteralPath $bom).IsReadOnly = $false
    $data | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $bom -Encoding utf8
    Move-Item -LiteralPath $stage -Destination $StageDirectory
} catch {
    Write-Warning "Incomplete staging directory is available for inspection at $stage"
    throw
}
Write-Output $StageDirectory
