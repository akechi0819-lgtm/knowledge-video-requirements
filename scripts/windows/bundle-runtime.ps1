#Requires -Version 7.2
[CmdletBinding()]
param(
    [switch] $DryRun,
    [string] $CacheDirectory = $env:JIANGJIE_WIN_RUNTIME_CACHE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$build = Join-Path $repo 'build'
$output = Join-Path $build 'win-runtime'
if (!$CacheDirectory) { $CacheDirectory = Join-Path $repo '.runtime/win-runtime' }
$cache = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CacheDirectory)
$registry = $env:JIANGJIE_NPM_REGISTRY
if (!$registry) { $registry = 'https://registry.npmjs.org' }
$registry = $registry.TrimEnd('/')
if ($registry -cnotin 'https://registry.npmjs.org', 'https://registry.npmmirror.com') {
    throw 'JIANGJIE_NPM_REGISTRY must be https://registry.npmjs.org or https://registry.npmmirror.com.'
}
if ($cache.Equals($output, [StringComparison]::OrdinalIgnoreCase) -or
    $cache.StartsWith($output + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The download cache must be outside build/win-runtime.'
}

$manifestPath = Join-Path $PSScriptRoot 'runtime-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json -AsHashtable
if ($manifest.schemaVersion -ne 1 -or $manifest.platform -cne 'win32-x64' -or
    $manifest.nodeStrategy -cne 'standalone' -or $manifest.assets.Count -ne 3) {
    throw 'Expected a schema v1 win32-x64 manifest with standalone Node.'
}
$node = $manifest.assets.node
$python = $manifest.assets.python
$ffmpeg = $manifest.assets.ffmpeg
if ($node.version -cnotmatch '^24\.\d+\.\d+$' -or [version]$node.version -lt [version]'24.9.0' -or
    $python.version -cnotmatch '^3\.13\.\d+$' -or $python.release -cnotmatch '^\d{8}$' -or
    $ffmpeg.version -cnotmatch '^8\.0(?:\.\d+)?$' -or $ffmpeg.license -cne 'GPL-3.0-or-later') {
    throw 'Invalid pinned versions or license in runtime-manifest.json.'
}
$nodeRoot = "node-v$($node.version)-win-x64"
$ffmpegRoot = "ffmpeg-$($ffmpeg.version)-essentials_build"
$pythonArchive = "cpython-$($python.version)+$($python.release)-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$assetSources = @(
    @{ Asset = $node; Name = "$nodeRoot.zip"; Base = "https://nodejs.org/dist/v$($node.version)" }
    @{ Asset = $python; Name = $pythonArchive; Base = "https://github.com/astral-sh/python-build-standalone/releases/download/$($python.release)" }
    @{ Asset = $ffmpeg; Name = "$ffmpegRoot.zip"; Base = "https://github.com/GyanD/codexffmpeg/releases/download/$($ffmpeg.version)" }
)
foreach ($source in $assetSources) {
    $asset = $source.Asset
    $url = $source.Base + '/' + [uri]::EscapeDataString($source.Name)
    if ($asset.archive -cne $source.Name -or $asset.url -cne $url -or $asset.sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw "Invalid archive, upstream URL or SHA-256 for $($source.Name)."
    }
}

$skills = [ordered]@{}
foreach ($name in 'andy-vibe-knowledge', 'deepseek-opus-motion-skill', 'vibe-knowledge-film') {
    $relative = ".project-skills/$name"
    $directory = Join-Path $repo $relative
    $message = "Missing or empty $relative. Run git submodule update --init --recursive."
    if (!(Test-Path -LiteralPath $directory -PathType Container) -or
        !(Get-ChildItem -LiteralPath $directory -File -Filter 'SKILL.md' -Recurse -Force | Select-Object -First 1)) {
        throw $message
    }
    $entry = git -C $repo ls-files --stage -- $relative
    if ($LASTEXITCODE -ne 0 -or $entry -notmatch '^160000 ([a-f0-9]{40}) 0\s') { throw $message }
    $pin = $Matches[1]
    $actual = git -C $directory rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0 -or $actual -cne $pin) {
        throw "$relative must be at $pin. Run git submodule update --init --recursive."
    }
    $skills[$relative] = $pin
}

function Assert-AssetHash($Asset, [string] $File) {
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $Asset.sha256) {
        throw "SHA-256 mismatch for $($Asset.archive). Expected $($Asset.sha256), got $actual."
    }
}

function Get-Asset($Asset) {
    $file = Join-Path $cache $Asset.archive
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        Assert-AssetHash $Asset $file
        return $file
    }
    $partial = "$file.$([guid]::NewGuid().ToString('N')).part"
    try {
        Write-Host "Downloading $($Asset.archive)"
        Invoke-WebRequest -Uri $Asset.url -OutFile $partial
        Assert-AssetHash $Asset $partial
        try { [IO.File]::Move($partial, $file) }
        catch [IO.IOException] {
            if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw }
            Assert-AssetHash $Asset $file
        }
    } finally {
        if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
    }
    return $file
}

if ($DryRun) {
    foreach ($asset in $manifest.assets.Values) {
        $file = Join-Path $cache $asset.archive
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            Assert-AssetHash $asset $file
            Write-Host "Verified cached $($asset.archive)"
        } else {
            Write-Host "Would download $($asset.archive)"
        }
    }
    Write-Host "Validated runtime manifest and three skill pins. npm registry: $registry"
    Write-Host 'Would assemble runtime/{node,python,codecs}, DSH and video-kit node_modules, and runtime-bom.json under build/win-runtime.'
    return
}

if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'Assemble the Windows x64 runtime on a Windows x64 build host.'
}
$tar = Join-Path $env:SystemRoot 'System32/tar.exe'
$null = New-Item -ItemType Directory -Force -Path $build, $cache
if ((Get-Item -LiteralPath $build).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw 'The build directory must be a real directory in the repository.'
}
$buildGuard = [IO.File]::Open((Join-Path $build '.win-runtime-lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$scratch = Join-Path $build ".win-runtime-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
try {
    $nodeZip = Get-Asset $node
    $pythonTar = Get-Asset $python
    $ffmpegZip = Get-Asset $ffmpeg
    $null = New-Item -ItemType Directory -Path $scratch
    & $tar -xf $nodeZip -C $scratch "$nodeRoot/node.exe" "$nodeRoot/LICENSE" "$nodeRoot/node_modules/npm/"
    if ($LASTEXITCODE -ne 0) { throw 'Node archive extraction failed.' }
    & $tar -xf $pythonTar -C $scratch
    if ($LASTEXITCODE -ne 0) { throw 'Python archive extraction failed.' }
    & $tar -xf $ffmpegZip -C $scratch "$ffmpegRoot/bin/ffmpeg.exe" "$ffmpegRoot/bin/ffprobe.exe" "$ffmpegRoot/LICENSE"
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg archive extraction failed.' }
    [IO.File]::WriteAllText((Join-Path $scratch 'skills.json'), ($skills | ConvertTo-Json))
    # Do not let build-host Node options run before the assembler has started.
    $nodeOptions = $env:NODE_OPTIONS
    $nodePath = $env:NODE_PATH
    try {
        Remove-Item Env:NODE_OPTIONS, Env:NODE_PATH -ErrorAction SilentlyContinue
        & (Join-Path $scratch "$nodeRoot/node.exe") (Join-Path $PSScriptRoot 'assemble-runtime.mjs') $repo $scratch $cache $registry
        if ($LASTEXITCODE -ne 0) { throw 'Runtime assembly failed.' }
    } finally {
        $env:NODE_OPTIONS = $nodeOptions
        $env:NODE_PATH = $nodePath
    }
} finally {
    if ([IO.Path]::GetDirectoryName($scratch) -cne $build -or [IO.Path]::GetFileName($scratch) -cnotmatch '^\.win-runtime-[a-f0-9]{12}$') {
        throw 'Unexpected runtime staging directory.'
    }
    try {
        if ((Test-Path -LiteralPath $scratch) -and !(Test-Path -LiteralPath (Join-Path $scratch 'preserve-staging'))) {
            Remove-Item -LiteralPath $scratch -Recurse -Force
        }
    } finally {
        $buildGuard.Dispose()
    }
}
