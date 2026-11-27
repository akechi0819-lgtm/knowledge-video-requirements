#Requires -Version 7.2
<#
.SYNOPSIS
    讲界视频工坊 Windows 纯净机全链路端到端冒烟验收脚本（CI 发布门禁）。
.DESCRIPTION
    模拟一台无 Node / Python / FFmpeg / Anaconda 等任何开发工具的普通用户 Windows 电脑，
    依次执行 5 项硬性发布门禁：
      0. 环境净化：将 PATH 清洗为仅含 Windows 基础系统目录，清除开发工具环境变量，断言宿主机工具不可见；
      1. 免 UAC 静默安装到 %LOCALAPPDATA%\Programs\Jiangjie，校验 HKCU 卸载项、文件布局与版本清单；
      2. 启动 Jiangjie.exe，等待内置 DSH 后端健康检查返回 HTTP 200，校验全部运行时进程源自安装目录；
      3. 在含中文与空格的测试数据路径下运行内置火锅蓝图冒烟测试，断言 final.mp4 存在、
         规格为 1280x720 / 30 fps / H.264 + AAC，且 verify.mjs 输出 VERIFY PASS（pass=true）；
      4. 关闭应用，断言 5 秒内所有关联子进程（Node / Python / FFmpeg / 无头 Edge / WebView2）归零；
      5. 执行静默卸载，断言程序安装目录与快捷方式/HKCU 注册表清理干净且无残留进程。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$InstallDir = '',

    [string]$SmokeDataRoot = '',

    [string]$BlueprintPath = '',

    [string]$ReportDir = '',

    [ValidateSet('auto', 'sapi', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural')]
    [string]$Voice = 'auto',

    [int]$StartupTimeoutSec = 90,

    [int]$ShutdownTimeoutSec = 5,

    [int]$UninstallTimeoutSec = 45,

    [switch]$ScrubMachinePath,

    [switch]$PurgeUserData,

    [switch]$KeepSmokeData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

if (-not $IsWindows) {
    throw 'e2e-clean-verify.ps1 must run on Windows x64.'
}

$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Installer executable not found: $InstallerPath"
}

$defaultInstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Jiangjie'
if (-not $InstallDir) {
    $InstallDir = $defaultInstallDir
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

$runStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
if (-not $SmokeDataRoot) {
    # 刻意包含中文与空格，覆盖 Unicode 与路径空格兼容门禁
    $SmokeDataRoot = Join-Path $env:LOCALAPPDATA "Jiangjie 验收测试\火锅 冒烟 $runStamp"
}
$SmokeDataRoot = [IO.Path]::GetFullPath($SmokeDataRoot)

if (-not $ReportDir) {
    $ReportDir = Join-Path ([IO.Path]::GetTempPath()) "jiangjie-e2e-report-$runStamp"
}
$ReportDir = [IO.Path]::GetFullPath($ReportDir)
$null = New-Item -ItemType Directory -Force -Path $ReportDir

$systemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$cleanSystemPath = @(
    (Join-Path $systemRoot 'System32'),
    $systemRoot,
    (Join-Path $systemRoot 'System32\Wbem'),
    (Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0')
) -join ';'

$report = [ordered]@{
    schemaVersion = 1
    startedAtUtc  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    installerPath = $InstallerPath
    installDir    = $InstallDir
    smokeDataRoot = $SmokeDataRoot
    cleanPath     = $cleanSystemPath
    stages        = [ordered]@{}
    passed        = $false
}

function Write-Step([string]$Message) {
    $ts = (Get-Date).ToUniversalTime().ToString('HH:mm:ss')
    Write-Host "[$ts] [e2e-clean] $Message"
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TrackedAppProcesses([string]$RootDir) {
    $normRoot = $RootDir.TrimEnd('\').ToLowerInvariant()
    $prefix = "$normRoot\"
    $targets = [System.Collections.Generic.List[object]]::new()
    $procs = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.ProcessId -eq $PID) { continue }
        $exe = if ($p.ExecutablePath) { $p.ExecutablePath.ToLowerInvariant() } else { '' }
        $cmd = if ($p.CommandLine) { $p.CommandLine.ToLowerInvariant() } else { '' }
        $name = if ($p.Name) { $p.Name.ToLowerInvariant() } else { '' }

        $underInstall = $exe.StartsWith($prefix) -or $cmd.Contains($normRoot)
        $knownAppBin = $name -in @(
            'jiangjie.exe', 'jiangjieapp.exe', 'jiangjieupdater.exe', 'bohackcredentialstore.exe'
        )
        $knownChildCmd = (
            $name -in @('node.exe', 'python.exe', 'pythonw.exe', 'ffmpeg.exe', 'ffprobe.exe', 'chrome.exe', 'msedge.exe', 'msedgewebview2.exe') -and
            ($exe.StartsWith($prefix) -or $cmd.Contains($normRoot) -or $cmd.Contains('dsh-workbench-fix') -or $cmd.Contains('bohack-blueprint') -or $cmd.Contains('start-dsh.mjs'))
        )

        if ($underInstall -or $knownAppBin -or $knownChildCmd) {
            $targets.Add([pscustomobject]@{
                ProcessId      = [int]$p.ProcessId
                ParentPid      = [int]$p.ParentProcessId
                Name           = $p.Name
                ExecutablePath = $p.ExecutablePath
                CommandLine    = $p.CommandLine
            })
        }
    }
    return , $targets.ToArray()
}

function Get-ListeningLoopbackPorts([int[]]$ProcessIds) {
    if (-not $ProcessIds -or @($ProcessIds).Count -eq 0) { return , [int[]]@() }
    $ports = [System.Collections.Generic.List[int]]::new()

    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.OwningProcess -in $ProcessIds) -and
                ($_.LocalAddress -in @('127.0.0.1', '::1', '0.0.0.0'))
            })
        foreach ($c in $conns) {
            if ($c.LocalPort -gt 0 -and -not $ports.Contains([int]$c.LocalPort)) {
                $ports.Add([int]$c.LocalPort)
            }
        }
    }

    if ($ports.Count -eq 0) {
        $netstat = Join-Path $systemRoot 'System32\netstat.exe'
        if (Test-Path -LiteralPath $netstat -PathType Leaf) {
            $lines = @(& $netstat -ano -p TCP 2>$null)
            foreach ($line in $lines) {
                if ($line -match '^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
                    $port = [int]$Matches[1]
                    $ownerPid = [int]$Matches[2]
                    if (($ownerPid -in $ProcessIds) -and -not $ports.Contains($port)) {
                        $ports.Add($port)
                    }
                }
            }
        }
    }
    return , $ports.ToArray()
}

function Resolve-SmokeVoice([string]$RequestedVoice) {
    if ($RequestedVoice -ne 'auto') { return $RequestedVoice }
    $winPs = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $winPs -PathType Leaf) {
        try {
            $probeScript = @'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
$synth.Dispose()
if ($zh) { Write-Output $zh.VoiceInfo.Name }
'@
            $zhVoice = (& $winPs -NoProfile -NonInteractive -Command $probeScript 2>$null | Select-Object -First 1)
            if ($zhVoice -and $zhVoice.Trim()) {
                Write-Step "Detected Chinese Windows SAPI voice: $($zhVoice.Trim()); using offline --voice sapi"
                return 'sapi'
            }
        } catch {
            Write-Step "SAPI voice probe inconclusive ($($_.Exception.Message)); falling back to Edge TTS."
        }
    }
    Write-Step 'No zh-* SAPI desktop voice found on this host; using packaged Edge TTS (zh-CN-XiaoxiaoNeural).'
    return 'zh-CN-XiaoxiaoNeural'
}

function Parse-RationalFps([string]$RateText) {
    if (-not $RateText) { return 0.0 }
    if ($RateText -match '^(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)$') {
        $den = [double]$Matches[2]
        if ($den -le 0) { return 0.0 }
        return ([double]$Matches[1]) / $den
    }
    $val = 0.0
    if ([double]::TryParse($RateText, [ref]$val)) { return $val }
    return 0.0
}

function Send-GracefulCloseToApp([int[]]$Pids) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JiangjieWinClose {
    public const uint WM_CLOSE = 0x0010;
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    public static int PostCloseByPid(int targetPid) {
        int sent = 0;
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if ((int)pid == targetPid) {
                if (PostMessageW(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) sent++;
            }
            return true;
        }, IntPtr.Zero);
        return sent;
    }
}
'@ -ErrorAction SilentlyContinue

    foreach ($appPid in $Pids) {
        $proc = Get-Process -Id $appPid -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $closed = $false
        try {
            if ($proc.CloseMainWindow()) { $closed = $true }
        } catch {}
        if (-not $closed) {
            $sent = [JiangjieWinClose]::PostCloseByPid($appPid)
            Write-Step "Posted WM_CLOSE to PID $appPid ($sent window handle(s))."
        } else {
            Write-Step "Sent CloseMainWindow() to PID $appPid."
        }
    }
}

function Save-DiagnosticsSnapshot([string]$Tag) {
    $logsSrc = Join-Path $env:LOCALAPPDATA 'Jiangjie\logs'
    if (Test-Path -LiteralPath $logsSrc -PathType Container) {
        $dst = Join-Path $ReportDir "logs-$Tag"
        $null = New-Item -ItemType Directory -Force -Path $dst
        Copy-Item -Path (Join-Path $logsSrc '*') -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$origProcessPath = $env:PATH
$origUserPath = $null
$origMachinePath = $null
$scrubbedRegistry = $false
$hiddenSystemShims = [System.Collections.Generic.List[hashtable]]::new()

try {
    # =========================================================================
    # Stage 0: Clean-Machine Environment Sanitization (Critical Defense Line)
    # =========================================================================
    Write-Step 'Stage 0: Sanitizing PATH and developer environment variables...'
    if ($ScrubMachinePath) {
        if (Test-IsAdministrator) {
            $origUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $origMachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
            [Environment]::SetEnvironmentVariable('Path', '', 'User')
            [Environment]::SetEnvironmentVariable('Path', $cleanSystemPath, 'Machine')
            $scrubbedRegistry = $true
            # GitHub-hosted Windows runners preinstall Python Launcher (py.exe/pyw.exe) directly
            # inside C:\Windows; temporarily hide those shims so host Python is 100% unreachable.
            foreach ($shimName in @('py.exe', 'pyw.exe')) {
                $shimPath = Join-Path $systemRoot $shimName
                if (Test-Path -LiteralPath $shimPath -PathType Leaf) {
                    $bakPath = "$shimPath.jj-e2e-hidden"
                    Move-Item -LiteralPath $shimPath -Destination $bakPath -Force
                    $hiddenSystemShims.Add(@{ Orig = $shimPath; Bak = $bakPath })
                }
            }
            Write-Step 'Scrubbed Machine & User registry PATH (and hid C:\Windows\py*.exe shims) to Windows system tools only.'
        } else {
            Write-Warning '[e2e-clean] -ScrubMachinePath requested without Administrator privileges; applying Process-level PATH isolation only.'
        }
    }

    $env:PATH = $cleanSystemPath
    [Environment]::SetEnvironmentVariable('PATH', $cleanSystemPath, 'Process')

    $scrubExact = @(
        'NODE_PATH', 'NODE_OPTIONS', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP',
        'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'CONDA_EXE', 'CONDA_PYTHON_EXE', 'VIRTUAL_ENV',
        'FFMPEG_PATH', 'FFPROBE_PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_NODEJS_PATH',
        'DSH_HOME', 'DSH_CLI', 'WORKBENCH_PORT',
        'JIANGJIE_APP_ROOT', 'JIANGJIE_DATA_DIR', 'JIANGJIE_CACHE_DIR', 'JIANGJIE_SKILLS_DIR',
        'JIANGJIE_WORKBENCH_WORKSPACE', 'JIANGJIE_DESKTOP_WORKSPACE', 'JIANGJIE_NODE', 'JIANGJIE_READY_ID'
    )
    foreach ($varName in $scrubExact) {
        Remove-Item "Env:$varName" -ErrorAction SilentlyContinue
    }
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($entry.Name -match '^(?:VIDEO_|npm_config_|PIP_|CONDA_|BOHACK_CLOUD_|WORKBENCH_MODEL_|SCENE_)') {
            Remove-Item "Env:$($entry.Name)" -ErrorAction SilentlyContinue
        }
    }

    $forbiddenTools = @('node', 'npm', 'npx', 'python', 'python3', 'py', 'ffmpeg', 'ffprobe', 'conda')
    $leaked = @()
    foreach ($tool in $forbiddenTools) {
        $hit = Get-Command $tool -ErrorAction SilentlyContinue
        if ($hit) { $leaked += "$tool -> $($hit.Source)" }
    }
    if ($leaked.Count -gt 0) {
        throw "Environment sanitization failed; host developer tools still visible on PATH: $($leaked -join ', ')"
    }
    $report.stages['envSanitization'] = [ordered]@{
        passed           = $true
        registryScrubbed = $scrubbedRegistry
        verifiedAbsent   = $forbiddenTools
    }
    Write-Step 'Stage 0 PASSED: Zero host Node/Python/FFmpeg/Conda tools visible on PATH.'

    # Ensure no pre-existing processes or stale install directory
    $preExisting = Get-TrackedAppProcesses $InstallDir
    if ($preExisting.Count -gt 0) {
        throw "Pre-existing Jiangjie processes detected before test: $($preExisting | ConvertTo-Json -Compress)"
    }
    if (Test-Path -LiteralPath $InstallDir) {
        Write-Step "Cleaning pre-existing install directory before fresh install: $InstallDir"
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
    }

    # =========================================================================
    # Stage 1: Silent Per-User Install (No UAC) to %LOCALAPPDATA%\Programs\Jiangjie
    # =========================================================================
    Write-Step "Stage 1: Running silent Per-User install to $InstallDir ..."
    $isDefaultDir = $InstallDir.TrimEnd('\').Equals($defaultInstallDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    $installArgLine = if ($isDefaultDir) { '/S /NOLAUNCH' } else { "/S /NOLAUNCH /D=$InstallDir" }
    $installSw = [Diagnostics.Stopwatch]::StartNew()
    $instProc = Start-Process -FilePath $InstallerPath -ArgumentList $installArgLine -Wait -PassThru
    $installSw.Stop()
    if ($instProc.ExitCode -ne 0) {
        throw "Silent installer failed with exit code $($instProc.ExitCode)"
    }

    $launcherExe = Join-Path $InstallDir 'Jiangjie.exe'
    $updaterExe = Join-Path $InstallDir 'JiangjieUpdater.exe'
    $uninstallerExe = Join-Path $InstallDir 'Uninstall.exe'
    $currentJsonPath = Join-Path $InstallDir 'current.json'
    foreach ($mustExist in @($launcherExe, $updaterExe, $uninstallerExe, $currentJsonPath)) {
        if (-not (Test-Path -LiteralPath $mustExist -PathType Leaf)) {
            throw "Expected installed file missing after silent install: $mustExist"
        }
    }

    $currentMeta = Get-Content -LiteralPath $currentJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
    $activeSeq = [int]$currentMeta.releaseSequence
    if ($activeSeq -lt 1) { throw "Invalid releaseSequence in current.json: $($currentMeta.releaseSequence)" }
    $versionRoot = Join-Path $InstallDir "versions\$activeSeq"

    $appExe = Join-Path $versionRoot 'JiangjieApp.exe'
    $pkgNode = Join-Path $versionRoot 'runtime\node\node.exe'
    $pkgPython = Join-Path $versionRoot 'runtime\python\python.exe'
    $pkgFfmpeg = Join-Path $versionRoot 'runtime\codecs\ffmpeg.exe'
    $pkgFfprobe = Join-Path $versionRoot 'runtime\codecs\ffprobe.exe'
    $pkgWebView2 = Join-Path $versionRoot 'runtime\webview2\msedgewebview2.exe'
    $pkgChromium = Join-Path $versionRoot 'runtime\chromium\chrome.exe'
    foreach ($bin in @($appExe, $pkgNode, $pkgPython, $pkgFfmpeg, $pkgFfprobe, $pkgWebView2, $pkgChromium)) {
        if (-not (Test-Path -LiteralPath $bin -PathType Leaf)) {
            throw "Expected bundled runtime binary missing: $bin"
        }
    }

    $uninstRegPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Jiangjie'
    if (-not (Test-Path -LiteralPath $uninstRegPath)) {
        throw "Per-User HKCU uninstall registry key missing: $uninstRegPath"
    }
    $regProps = Get-ItemProperty -LiteralPath $uninstRegPath
    if (-not $regProps.QuietUninstallString) {
        throw 'HKCU uninstall key missing QuietUninstallString.'
    }

    # Verify /S /NOLAUNCH did not auto-launch the app
    Start-Sleep -Milliseconds 800
    $unexpectedProcs = Get-TrackedAppProcesses $InstallDir
    if ($unexpectedProcs.Count -gt 0) {
        throw "Silent install unexpectedly auto-launched processes: $($unexpectedProcs | ConvertTo-Json -Compress)"
    }

    $report.stages['silentInstall'] = [ordered]@{
        passed          = $true
        durationSec     = [math]::Round($installSw.Elapsed.TotalSeconds, 2)
        version         = "$($currentMeta.version)"
        releaseSequence = $activeSeq
        channel         = "$($currentMeta.channel)"
        hkcuUninstall   = $true
    }
    Write-Step "Stage 1 PASSED: Installed v$($currentMeta.version) (seq $activeSeq) in $([math]::Round($installSw.Elapsed.TotalSeconds, 1))s."

    # =========================================================================
    # Stage 2: Launch Jiangjie.exe & Wait for Backend Health Check HTTP 200
    # =========================================================================
    Write-Step 'Stage 2: Launching Jiangjie.exe and waiting for /bohack/api/health HTTP 200...'
    $mainLogPath = Join-Path $env:LOCALAPPDATA 'Jiangjie\logs\main.log'
    $mainLogStartLen = if (Test-Path -LiteralPath $mainLogPath -PathType Leaf) { (Get-Item -LiteralPath $mainLogPath).Length } else { 0 }

    $launchSw = [Diagnostics.Stopwatch]::StartNew()
    $null = Start-Process -FilePath $launcherExe -WorkingDirectory $InstallDir -PassThru

    $healthPort = 0
    $healthBody = ''
    $appPid = 0
    $workbenchReadyLogged = $false
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)

    while ((Get-Date) -lt $deadline) {
        $tracked = Get-TrackedAppProcesses $InstallDir
        $appProc = $tracked | Where-Object { $_.Name -ieq 'JiangjieApp.exe' } | Select-Object -First 1
        if ($appProc) { $appPid = $appProc.ProcessId }

        # Inspect new main.log entries for early failure detection
        if (Test-Path -LiteralPath $mainLogPath -PathType Leaf) {
            $logLen = (Get-Item -LiteralPath $mainLogPath).Length
            if ($logLen -gt $mainLogStartLen) {
                $fs = [IO.File]::Open($mainLogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
                try {
                    $null = $fs.Seek($mainLogStartLen, [IO.SeekOrigin]::Begin)
                    $reader = [IO.StreamReader]::new($fs, [Text.Encoding]::UTF8)
                    $newLog = $reader.ReadToEnd()
                } finally {
                    $fs.Dispose()
                }
                if ($newLog -match '"event":"desktop_failure"') {
                    Save-DiagnosticsSnapshot 'startup-failure'
                    throw "JiangjieApp.exe reported desktop_failure during startup:`n$newLog"
                }
                if ($newLog -match '"event":"workbench_ready"') {
                    $workbenchReadyLogged = $true
                }
            }
        }

        $nodePids = @($tracked | Where-Object { $_.Name -ieq 'node.exe' } | ForEach-Object { $_.ProcessId })
        if ($nodePids.Count -gt 0) {
            $ports = Get-ListeningLoopbackPorts $nodePids
            foreach ($p in $ports) {
                try {
                    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$p/bohack/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
                    if ($resp.StatusCode -eq 200) {
                        $healthPort = $p
                        $healthBody = "$($resp.Content)"
                        break
                    }
                } catch {}
            }
        }

        if ($healthPort -gt 0) { break }
        Start-Sleep -Milliseconds 400
    }

    if ($healthPort -eq 0) {
        Save-DiagnosticsSnapshot 'health-timeout'
        $dump = Get-TrackedAppProcesses $InstallDir | ConvertTo-Json -Depth 4
        throw "Timed out after ${StartupTimeoutSec}s waiting for /bohack/api/health HTTP 200. Active tracked processes:`n$dump"
    }

    # Give WebView2 up to 15s after backend HTTP 200 to log workbench_ready (and verify no desktop_failure)
    $readyWaitDeadline = (Get-Date).AddSeconds(15)
    while (-not $workbenchReadyLogged -and (Get-Date) -lt $readyWaitDeadline) {
        if (Test-Path -LiteralPath $mainLogPath -PathType Leaf) {
            $fs = [IO.File]::Open($mainLogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            try {
                $null = $fs.Seek($mainLogStartLen, [IO.SeekOrigin]::Begin)
                $reader = [IO.StreamReader]::new($fs, [Text.Encoding]::UTF8)
                $newLog = $reader.ReadToEnd()
            } finally {
                $fs.Dispose()
            }
            if ($newLog -match '"event":"desktop_failure"') {
                Save-DiagnosticsSnapshot 'webview-failure'
                throw "JiangjieApp.exe reported desktop_failure after backend health:`n$newLog"
            }
            if ($newLog -match '"event":"workbench_ready"') {
                $workbenchReadyLogged = $true
                break
            }
        }
        Start-Sleep -Milliseconds 300
    }
    $launchSw.Stop()

    # Assert every running Node / WebView2 process belongs strictly to $InstallDir (zero host leakage)
    $runningNow = Get-TrackedAppProcesses $InstallDir
    $normPrefix = $InstallDir.TrimEnd('\').ToLowerInvariant() + '\'
    foreach ($proc in $runningNow) {
        if ($proc.ExecutablePath -and -not $proc.ExecutablePath.ToLowerInvariant().StartsWith($normPrefix)) {
            throw "Host binary leakage detected! Process $($proc.Name) (PID $($proc.ProcessId)) resolved outside install dir: $($proc.ExecutablePath)"
        }
    }

    $report.stages['appStartupHealth'] = [ordered]@{
        passed          = $true
        durationSec     = [math]::Round($launchSw.Elapsed.TotalSeconds, 2)
        appPid          = $appPid
        healthUrl       = "http://127.0.0.1:$healthPort/bohack/api/health"
        httpStatus      = 200
        workbenchReady  = $workbenchReadyLogged
        activeProcesses = $runningNow.Count
    }
    Write-Step "Stage 2 PASSED: /bohack/api/health returned HTTP 200 on 127.0.0.1:$healthPort (workbench_ready=$workbenchReadyLogged, $($runningNow.Count) isolated process(es))."

    # =========================================================================
    # Stage 3: Built-in Hotpot Blueprint Smoke Test (Chinese + Spaces Data Path)
    # =========================================================================
    Write-Step "Stage 3: Running built-in hotpot smoke test under Unicode/space path: $SmokeDataRoot ..."
    if (-not $BlueprintPath) {
        $BlueprintPath = Join-Path $versionRoot 'video-kit\examples\hotpot.v1.json'
    }
    $BlueprintPath = [IO.Path]::GetFullPath($BlueprintPath)
    if (-not (Test-Path -LiteralPath $BlueprintPath -PathType Leaf)) {
        throw "Built-in hotpot smoke blueprint not found: $BlueprintPath"
    }

    $smokeDataDir = Join-Path $SmokeDataRoot '用户数据 目录'
    $smokeCacheDir = Join-Path $SmokeDataRoot '缓存 目录'
    $smokeTmpDir = Join-Path $smokeCacheDir 'tmp'
    $smokeOutDir = Join-Path $SmokeDataRoot '火锅成片 输出'
    $null = New-Item -ItemType Directory -Force -Path $smokeDataDir, $smokeCacheDir, $smokeTmpDir, $smokeOutDir

    $resolvedVoice = Resolve-SmokeVoice $Voice
    $pipelineScript = Join-Path $versionRoot 'video-kit\WORK\modules\video\pipeline.mjs'
    $verifyScript = Join-Path $versionRoot 'video-kit\WORK\modules\video\verify.mjs'

    $smokeSw = [Diagnostics.Stopwatch]::StartNew()
    $smokeEnvBackup = @{}
    $smokeEnvVars = @{
        JIANGJIE_APP_ROOT              = $versionRoot
        JIANGJIE_DATA_DIR              = $smokeDataDir
        JIANGJIE_CACHE_DIR             = $smokeCacheDir
        VIDEO_KIT_DIR                  = (Join-Path $versionRoot 'video-kit')
        VIDEO_PYTHON                   = $pkgPython
        VIDEO_FFMPEG                   = $pkgFfmpeg
        VIDEO_FFPROBE                  = $pkgFfprobe
        VIDEO_BROWSER                  = $pkgChromium
        VIDEO_EDGE_PATH                = $pkgChromium
        VIDEO_PLAYWRIGHT               = (Join-Path $versionRoot 'video-kit\node_modules\playwright-core')
        TEMP                           = $smokeTmpDir
        TMP                            = $smokeTmpDir
        TMPDIR                         = $smokeTmpDir
        XDG_CACHE_HOME                 = $smokeCacheDir
        PYTHONUTF8                     = '1'
        PYTHONIOENCODING               = 'utf-8'
        PYTHONNOUSERSITE               = '1'
        PYTHONDONTWRITEBYTECODE        = '1'
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    }
    try {
        foreach ($kv in $smokeEnvVars.GetEnumerator()) {
            $smokeEnvBackup[$kv.Key] = [Environment]::GetEnvironmentVariable($kv.Key, 'Process')
            [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, 'Process')
        }

        Write-Step "Executing packaged pipeline.mjs (voice=$resolvedVoice)..."
        & $pkgNode $pipelineScript $BlueprintPath --out $smokeOutDir --voice $resolvedVoice
        if ($LASTEXITCODE -ne 0) {
            throw "Hotpot pipeline.mjs failed with exit code $LASTEXITCODE"
        }

        $finalMp4 = Join-Path $smokeOutDir 'final.mp4'
        $mappingJson = Join-Path $smokeOutDir 'mapping.json'
        if (-not (Test-Path -LiteralPath $finalMp4 -PathType Leaf)) {
            throw "Expected output video missing: $finalMp4"
        }
        $mp4Size = (Get-Item -LiteralPath $finalMp4).Length
        if ($mp4Size -le 0) {
            throw "Output video final.mp4 is empty (0 bytes)."
        }

        Write-Step 'Executing packaged verify.mjs...'
        $verifyOutputLines = & $pkgNode $verifyScript $mappingJson 2>&1
        $verifyExit = $LASTEXITCODE
        $verifyText = ($verifyOutputLines | ForEach-Object { "$_" }) -join "`n"
        Write-Host $verifyText
        if ($verifyExit -ne 0) {
            throw "verify.mjs exited with non-zero code $verifyExit"
        }
        if ($verifyText -notmatch 'VERIFY PASS') {
            throw "verify.mjs output did not contain 'VERIFY PASS'."
        }

        $verifyReportPath = Join-Path $smokeOutDir 'verify-report.json'
        if (-not (Test-Path -LiteralPath $verifyReportPath -PathType Leaf)) {
            throw "Missing verify-report.json at $verifyReportPath"
        }
        $verifyReport = Get-Content -LiteralPath $verifyReportPath -Raw -Encoding utf8 | ConvertFrom-Json
        if (-not $verifyReport.pass) {
            throw "verify-report.json reported pass=false: $($verifyReport.problems -join '; ')"
        }
        if (@($verifyReport.segments).Count -ne 4) {
            throw "Expected 4 hotpot segments in verify-report.json, got $(@($verifyReport.segments).Count)"
        }

        # Assert video/audio stream specs via packaged ffprobe.exe
        $probeRaw = & $pkgFfprobe -v error -show_streams -show_format -of json $finalMp4
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged ffprobe.exe failed with exit code $LASTEXITCODE"
        }
        $probe = $probeRaw | ConvertFrom-Json
        $vStream = $probe.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
        $aStream = $probe.streams | Where-Object { $_.codec_type -eq 'audio' } | Select-Object -First 1
        if (-not $vStream) { throw 'final.mp4 has no video stream.' }
        if (-not $aStream) { throw 'final.mp4 has no audio stream.' }

        $vCodec = "$($vStream.codec_name)".ToLowerInvariant()
        $aCodec = "$($aStream.codec_name)".ToLowerInvariant()
        $width = [int]$vStream.width
        $height = [int]$vStream.height
        $fps = Parse-RationalFps "$($vStream.avg_frame_rate)"
        if ($fps -le 0) { $fps = Parse-RationalFps "$($vStream.r_frame_rate)" }
        $duration = [double]$probe.format.duration

        if ($vCodec -ne 'h264') { throw "Expected video codec h264, got $vCodec" }
        if ($aCodec -ne 'aac') { throw "Expected audio codec aac, got $aCodec" }
        if ($width -ne 1280 -or $height -ne 720) { throw "Expected 1280x720 video, got ${width}x${height}" }
        if ([math]::Abs($fps - 30.0) -gt 0.1) { throw "Expected 30 fps video, got $fps fps" }
        if ($duration -lt 5.0) { throw "Unexpectedly short final.mp4 duration: $duration s" }

        Copy-Item -LiteralPath $verifyReportPath -Destination (Join-Path $ReportDir 'verify-report.json') -Force
        $smokeSw.Stop()

        $report.stages['hotpotSmoke'] = [ordered]@{
            passed      = $true
            durationSec = [math]::Round($smokeSw.Elapsed.TotalSeconds, 2)
            voice       = $resolvedVoice
            outputPath  = $finalMp4
            sizeBytes   = $mp4Size
            videoCodec  = $vCodec
            audioCodec  = $aCodec
            resolution  = "${width}x${height}"
            fps         = [math]::Round($fps, 3)
            filmSeconds = [math]::Round($duration, 3)
            segments    = @($verifyReport.segments).Count
            verifyPass  = $true
        }
        Write-Step "Stage 3 PASSED: final.mp4 (${width}x${height}, $([math]::Round($fps, 2)) fps, $vCodec+$aCodec, $([math]::Round($duration, 2))s) + VERIFY PASS."
    } finally {
        foreach ($kv in $smokeEnvBackup.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, 'Process')
        }
    }

    # =========================================================================
    # Stage 4: Close App & Assert Zero Orphan Child Processes Within 5 Seconds
    # =========================================================================
    Write-Step "Stage 4: Closing JiangjieApp.exe and asserting zero orphan processes within ${ShutdownTimeoutSec}s..."
    Save-DiagnosticsSnapshot 'before-close'

    $appPids = @(Get-TrackedAppProcesses $InstallDir | Where-Object { $_.Name -ieq 'JiangjieApp.exe' } | ForEach-Object { $_.ProcessId })
    if ($appPids.Count -eq 0) {
        throw 'JiangjieApp.exe was no longer running before Stage 4 close test.'
    }

    $closeSw = [Diagnostics.Stopwatch]::StartNew()
    Send-GracefulCloseToApp $appPids

    $remaining = @()
    $closeDeadline = (Get-Date).AddSeconds($ShutdownTimeoutSec)
    while ((Get-Date) -lt $closeDeadline) {
        $remaining = Get-TrackedAppProcesses $InstallDir
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    }
    $closeSw.Stop()

    if ($remaining.Count -gt 0) {
        Save-DiagnosticsSnapshot 'orphan-failure'
        $details = $remaining | ConvertTo-Json -Depth 4
        throw "Job Object cleanup gate FAILED: $($remaining.Count) process(es) still alive after ${ShutdownTimeoutSec}s:`n$details"
    }

    $report.stages['jobObjectShutdown'] = [ordered]@{
        passed            = $true
        shutdownMs        = [int]$closeSw.ElapsedMilliseconds
        limitSec          = $ShutdownTimeoutSec
        remainingChildren = 0
    }
    Write-Step "Stage 4 PASSED: All app & child processes exited cleanly in $($closeSw.ElapsedMilliseconds) ms (0 orphans)."

    # =========================================================================
    # Stage 5: Silent Uninstall & Assert Clean Directory + Zero Residual Procs
    # =========================================================================
    Write-Step 'Stage 5: Running silent uninstaller and verifying clean removal...'
    $uninstArgs = if ($PurgeUserData) { '/S /PURGEDATA' } else { '/S' }
    $uninstSw = [Diagnostics.Stopwatch]::StartNew()
    $uninstProc = Start-Process -FilePath $uninstallerExe -ArgumentList $uninstArgs -Wait -PassThru
    if ($uninstProc.ExitCode -ne 0) {
        throw "Silent uninstaller exited with code $($uninstProc.ExitCode)"
    }

    # NSIS silent uninstaller spawns a temporary copy (Au_.exe / Un_*.exe) to delete itself & $INSTDIR
    $uninstDeadline = (Get-Date).AddSeconds($UninstallTimeoutSec)
    while ((Get-Date) -lt $uninstDeadline) {
        $dirGone = -not (Test-Path -LiteralPath $InstallDir)
        $regGone = -not (Test-Path -LiteralPath $uninstRegPath)
        $uninstHelpers = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.Name -match '^(?:Au_|Un_).*\.exe$') -and
                ($_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($InstallDir.ToLowerInvariant()))
            })
        if ($dirGone -and $regGone -and $uninstHelpers.Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }
    $uninstSw.Stop()

    if (Test-Path -LiteralPath $InstallDir) {
        $leftovers = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        throw "Install directory not cleanly removed after silent uninstall ($InstallDir). Remaining items: $($leftovers -join ', ')"
    }
    if (Test-Path -LiteralPath $uninstRegPath) {
        throw "HKCU uninstall registry key still present after uninstall: $uninstRegPath"
    }

    $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) '讲界视频工坊.lnk'
    $startMenuDir = Join-Path ([Environment]::GetFolderPath('Programs')) '讲界视频工坊'
    if (Test-Path -LiteralPath $desktopShortcut) { throw "Desktop shortcut still exists: $desktopShortcut" }
    if (Test-Path -LiteralPath $startMenuDir) { throw "Start Menu directory still exists: $startMenuDir" }

    $postUninstProcs = Get-TrackedAppProcesses $InstallDir
    if ($postUninstProcs.Count -gt 0) {
        throw "Residual processes detected after uninstall: $($postUninstProcs | ConvertTo-Json -Depth 4)"
    }

    $report.stages['silentUninstall'] = [ordered]@{
        passed            = $true
        durationSec       = [math]::Round($uninstSw.Elapsed.TotalSeconds, 2)
        installDirRemoved = $true
        registryRemoved   = $true
        shortcutsRemoved  = $true
        residualProcesses = 0
    }
    Write-Step "Stage 5 PASSED: Install directory, HKCU registry, and shortcuts removed cleanly with 0 residual processes."

    $report.passed = $true
    $report.finishedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Write-Step 'ALL 5 CLEAN-MACHINE E2E GATES PASSED!'
} catch {
    $report.passed = $false
    $report.error = $_.Exception.Message
    $report.finishedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    throw
} finally {
    # Always restore host PATH so CI post-steps remain unaffected
    $env:PATH = $origProcessPath
    [Environment]::SetEnvironmentVariable('PATH', $origProcessPath, 'Process')
    if ($scrubbedRegistry) {
        [Environment]::SetEnvironmentVariable('Path', $origUserPath, 'User')
        [Environment]::SetEnvironmentVariable('Path', $origMachinePath, 'Machine')
    }
    foreach ($shim in $hiddenSystemShims) {
        if (Test-Path -LiteralPath $shim.Bak -PathType Leaf) {
            Move-Item -LiteralPath $shim.Bak -Destination $shim.Orig -Force -ErrorAction SilentlyContinue
        }
    }

    # Best-effort cleanup of any leaked processes if a stage aborted early
    if (-not $report.passed) {
        foreach ($p in (Get-TrackedAppProcesses $InstallDir)) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not $KeepSmokeData -and (Test-Path -LiteralPath $SmokeDataRoot)) {
        Remove-Item -LiteralPath $SmokeDataRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    $reportFile = Join-Path $ReportDir 'e2e-verify-report.json'
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportFile -Encoding utf8
    Write-Host "[e2e-clean] Report written to: $reportFile"
}
