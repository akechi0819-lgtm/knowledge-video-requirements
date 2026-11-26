#Requires -Version 7.2
<#
.SYNOPSIS
    讲界视频工坊 Windows 代码签名解耦钩子脚本（支持无证书本地构建与有证书 CI 签名）。
.DESCRIPTION
    通过环境变量 WIN_SIGN_MODE（或 -Mode 参数）支持三种模式：
      - none                  : 本地开发/测试跳过签名（仍执行文件存在性与反 UPX 门禁）
      - azure-trusted-signing : 微软 Azure Trusted Signing 云签名 + RFC 3161 时间戳
      - signtool-ev           : 传统 EV 证书 / 云 HSM / PFX + RFC 3161 时间戳

    安全门禁：
      1. 严禁使用 UPX 等易触发杀软误报的加壳工具（扫描 PE 节表，发现 UPX0/UPX1/UPX! 直接中止）；
      2. 强制 SHA-256 摘要与 RFC 3161 时间戳（/fd SHA256 /td SHA256 /tr）；
      3. 签名完成后逐文件调用 signtool verify /pa /v 与 Get-AuthenticodeSignature 校验；
      4. 绝不向 stdout/stderr 或报告文件打印任何私钥、密码或凭据。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Files,

    [ValidateSet('none', 'azure-trusted-signing', 'signtool-ev')]
    [string]$Mode = $(if ($env:WIN_SIGN_MODE) { $env:WIN_SIGN_MODE.ToLowerInvariant() } else { 'none' }),

    [string]$Description = '讲界视频工坊 (Jiangjie Studio)',
    [string]$DescriptionUrl = 'https://jiangjie.gingers.cloud/',
    [string]$TimestampUrl = $(if ($env:WIN_SIGN_TIMESTAMP_URL) { $env:WIN_SIGN_TIMESTAMP_URL } else { '' }),
    [string]$SignToolPath = $env:WIN_SIGNTOOL_PATH,
    [string]$ReportPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-SignTool([string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) {
            throw "Configured signtool.exe not found: $Explicit"
        }
        return [IO.Path]::GetFullPath($Explicit)
    }
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kits -PathType Container) {
        $found = Get-ChildItem -LiteralPath $kits -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like '*\x64\signtool.exe' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

function Assert-NotUpxPacked([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $len = [int][Math]::Min($stream.Length, 8192)
        $buf = New-Object byte[] $len
        $null = $stream.Read($buf, 0, $len)
        $ascii = [Text.Encoding]::ASCII.GetString($buf)
        foreach ($marker in @('UPX0', 'UPX1', 'UPX!')) {
            if ($ascii.Contains($marker)) {
                throw "Security gate failed: forbidden UPX packer signature ($marker) detected in $Path"
            }
        }
    } finally {
        $stream.Dispose()
    }
}

function Invoke-SignToolWithRetry([string]$SignTool, [string[]]$Arguments, [int]$MaxAttempts = 3) {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        & $SignTool @Arguments
        if ($LASTEXITCODE -eq 0) { return }
        if ($attempt -lt $MaxAttempts) {
            Write-Warning "[sign] signtool attempt $attempt failed (exit $LASTEXITCODE); retrying in 3s..."
            Start-Sleep -Seconds 3
        } else {
            throw "signtool.exe failed after $MaxAttempts attempts (exit $LASTEXITCODE)."
        }
    }
}

$resolvedFiles = @()
foreach ($f in $Files) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
        throw "Target file to sign does not exist: $f"
    }
    $full = [IO.Path]::GetFullPath($f)
    Assert-NotUpxPacked $full
    $resolvedFiles += $full
}

$results = [System.Collections.Generic.List[object]]::new()
$startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

if ($Mode -eq 'none') {
    Write-Host "[sign] WIN_SIGN_MODE=none: skipping Authenticode signing for $($resolvedFiles.Count) file(s) (UPX gate passed)."
    foreach ($file in $resolvedFiles) {
        $results.Add([ordered]@{
            file      = $file
            mode      = 'none'
            status    = 'skipped'
            upxCheck  = 'passed'
            sha256    = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        })
    }
} else {
    $signTool = Resolve-SignTool $SignToolPath
    if (-not $signTool) {
        throw 'signtool.exe not found. Install Windows 10/11 SDK or set WIN_SIGNTOOL_PATH.'
    }

    if ($Mode -eq 'azure-trusted-signing') {
        $endpoint = $env:AZURE_SIGNING_ENDPOINT
        $account = $env:AZURE_SIGNING_ACCOUNT
        $profile = $env:AZURE_SIGNING_CERT_PROFILE
        $dlib = $env:AZURE_SIGNING_DLIB_PATH
        if (-not $endpoint -or -not $account -or -not $profile) {
            throw 'azure-trusted-signing requires AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, and AZURE_SIGNING_CERT_PROFILE.'
        }
        if (-not $dlib -or -not (Test-Path -LiteralPath $dlib -PathType Leaf)) {
            throw 'azure-trusted-signing requires AZURE_SIGNING_DLIB_PATH pointing to Azure.CodeSigning.Dlib.dll.'
        }
        $tsUrl = if ($TimestampUrl) { $TimestampUrl } else { 'http://timestamp.acs.microsoft.com' }

        $metaFile = Join-Path ([IO.Path]::GetTempPath()) ("jiangjie-acs-meta-" + [guid]::NewGuid().ToString('N') + '.json')
        try {
            $metaObj = [ordered]@{
                Endpoint               = $endpoint
                CodeSigningAccountName = $account
                CertificateProfileName = $profile
            }
            if ($env:AZURE_SIGNING_CORRELATION_ID) {
                $metaObj.CorrelationId = $env:AZURE_SIGNING_CORRELATION_ID
            }
            $metaObj | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metaFile -Encoding utf8

            foreach ($file in $resolvedFiles) {
                Write-Host "[sign] Azure Trusted Signing -> $(Split-Path -Leaf $file)"
                $args = @(
                    'sign', '/v', '/fd', 'SHA256',
                    '/tr', $tsUrl, '/td', 'SHA256',
                    '/dlib', $dlib, '/dmdf', $metaFile,
                    '/d', $Description, '/du', $DescriptionUrl,
                    $file
                )
                if (-not $DryRun) {
                    Invoke-SignToolWithRetry $signTool $args
                    & $signTool verify /pa /v $file | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw "Post-sign Authenticode verification failed for $file" }
                }
                $sig = if ($DryRun) { $null } else { Get-AuthenticodeSignature -LiteralPath $file }
                $results.Add([ordered]@{
                    file      = $file
                    mode      = $Mode
                    status    = if ($DryRun) { 'dry-run' } else { 'signed' }
                    verify    = if ($DryRun) { 'dry-run' } else { "$($sig.Status)" }
                    subject   = if ($sig -and $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }
                    timestamp = $tsUrl
                    upxCheck  = 'passed'
                    sha256    = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
                })
            }
        } finally {
            if (Test-Path -LiteralPath $metaFile -PathType Leaf) {
                Remove-Item -LiteralPath $metaFile -Force -ErrorAction SilentlyContinue
            }
        }
    } elseif ($Mode -eq 'signtool-ev') {
        $tsUrl = if ($TimestampUrl) { $TimestampUrl } else { 'http://timestamp.digicert.com' }
        $sha1 = $env:WIN_SIGN_CERT_SHA1
        $pfxPath = $env:WIN_SIGN_PFX_PATH
        $pfxPassword = $env:WIN_SIGN_PFX_PASSWORD
        $csp = $env:WIN_SIGN_CSP
        $keyContainer = $env:WIN_SIGN_KEY_CONTAINER
        $certFile = $env:WIN_SIGN_CERT_FILE

        $credArgs = @()
        if ($csp -and $keyContainer -and $certFile) {
            if (-not (Test-Path -LiteralPath $certFile -PathType Leaf)) { throw "WIN_SIGN_CERT_FILE not found: $certFile" }
            $credArgs = @('/f', $certFile, '/csp', $csp, '/kc', $keyContainer)
        } elseif ($pfxPath) {
            if (-not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) { throw "WIN_SIGN_PFX_PATH not found: $pfxPath" }
            $credArgs = @('/f', $pfxPath)
            if ($pfxPassword) { $credArgs += @('/p', $pfxPassword) }
        } elseif ($sha1) {
            if ($sha1 -notmatch '^[0-9a-fA-F]{40}$') { throw 'WIN_SIGN_CERT_SHA1 must be a 40-char SHA-1 thumbprint.' }
            $credArgs = @('/sha1', $sha1)
        } else {
            throw 'signtool-ev requires one of: WIN_SIGN_CERT_SHA1, WIN_SIGN_PFX_PATH, or (WIN_SIGN_CSP + WIN_SIGN_KEY_CONTAINER + WIN_SIGN_CERT_FILE).'
        }

        foreach ($file in $resolvedFiles) {
            Write-Host "[sign] SignTool EV/HSM -> $(Split-Path -Leaf $file)"
            $args = @('sign', '/v', '/fd', 'SHA256', '/tr', $tsUrl, '/td', 'SHA256', '/d', $Description, '/du', $DescriptionUrl) + $credArgs + @($file)
            if (-not $DryRun) {
                Invoke-SignToolWithRetry $signTool $args
                & $signTool verify /pa /v $file | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "Post-sign Authenticode verification failed for $file" }
            }
            $sig = if ($DryRun) { $null } else { Get-AuthenticodeSignature -LiteralPath $file }
            $results.Add([ordered]@{
                file      = $file
                mode      = $Mode
                status    = if ($DryRun) { 'dry-run' } else { 'signed' }
                verify    = if ($DryRun) { 'dry-run' } else { "$($sig.Status)" }
                subject   = if ($sig -and $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null }
                timestamp = $tsUrl
                upxCheck  = 'passed'
                sha256    = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            })
        }
    }
}

$report = [ordered]@{
    schemaVersion = 1
    timestampUtc  = $startedAt
    mode          = $Mode
    dryRun        = [bool]$DryRun
    fileCount     = $results.Count
    files         = $results
}

if ($ReportPath) {
    $parent = Split-Path -Parent $ReportPath
    if ($parent) { $null = New-Item -ItemType Directory -Force $parent }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}
Write-Host "[sign] Completed ($Mode): $($results.Count) file(s) processed."
