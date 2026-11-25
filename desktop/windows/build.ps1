# Build on Windows x64 with .NET 8, Inno Setup 6, and MSYS2 MINGW64
# (gcc, make, nasm, pkgconf, diffutils, tar and curl). Run from any directory:
# pwsh -File desktop/windows/build.ps1 -OutputDirectory C:\jiangjie-build
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$MsysBash = 'C:\msys64\usr\bin\bash.exe',
    [string]$InnoCompiler = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
$stage = Join-Path $output 'stage'
$cache = Join-Path $output 'cache'
$resources = Join-Path $stage 'resources'
$runtime = Join-Path $resources 'runtime'
$base = Join-Path $resources 'dsh-workbench-fix/dsh-base'
$kit = Join-Path $resources 'video-kit'
$sourceBase = Join-Path $repo 'dsh-workbench-fix/dsh-base'
$plugin = Join-Path $base 'packages/bohack-blueprint'
$codecDir = Join-Path $cache 'codecs'
$env:MSYSTEM = 'MINGW64'
$env:CHERE_INVOKING = 'yes'
$env:MSYS2_PATH_TYPE = 'inherit'

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}
function Get-VerifiedFile {
    param([string]$Url, [string]$Path, [string]$Sha256)
    if (-not (Test-Path $Path)) {
        $temporary = "$Path.download"
        Invoke-WebRequest -Uri $Url -OutFile $temporary
        if ((Get-FileHash -Algorithm SHA256 $temporary).Hash -ne $Sha256) {
            Remove-Item $temporary
            throw "Checksum mismatch for $Url"
        }
        Move-Item $temporary $Path
    }
    if ((Get-FileHash -Algorithm SHA256 $Path).Hash -ne $Sha256) {
        throw "Checksum mismatch for $Path"
    }
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw '此构建脚本需要 Windows x64 构建机。'
}
if (-not (Test-Path $MsysBash)) { throw "MSYS2 bash 未找到：$MsysBash" }
if (-not (Test-Path $InnoCompiler)) { throw "Inno Setup 未找到：$InnoCompiler" }
New-Item -ItemType Directory -Force $output, $cache | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage, $runtime, $base, $kit, $plugin, $codecDir | Out-Null

$nodeZip = Join-Path $cache 'node-v24.22.1-win-x64.zip'
Get-VerifiedFile 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip' $nodeZip 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
$nodeExtract = Join-Path $cache 'node-v24.22.1-win-x64'
if (-not (Test-Path (Join-Path $nodeExtract 'node.exe'))) {
    Expand-Archive $nodeZip -DestinationPath $cache -Force
}
$node = Join-Path $nodeExtract 'node.exe'
$npm = Join-Path $nodeExtract 'node_modules/npm/bin/npm-cli.js'
New-Item -ItemType Directory -Force (Join-Path $runtime 'node') | Out-Null
Copy-Item $node, (Join-Path $nodeExtract 'LICENSE') (Join-Path $runtime 'node')

$pythonArchive = Join-Path $cache 'cpython-3.12.14+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
Get-VerifiedFile 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz' $pythonArchive '7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14'
$pythonDir = Join-Path $runtime 'python'
New-Item -ItemType Directory -Force $pythonDir | Out-Null
Invoke-Checked 'tar.exe' @('-xzf', $pythonArchive, '--strip-components=1', '-C', $pythonDir)
$python = Join-Path $pythonDir 'python.exe'
Invoke-Checked $python @('-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--no-compile', '-r', (Join-Path $repo 'video-kit/requirements.txt'), '-c', (Join-Path $repo 'desktop/python-constraints.txt'))

$profile = Join-Path $base '.dsh-home/profiles/workbench'
New-Item -ItemType Directory -Force $profile, (Join-Path $base 'workspace') | Out-Null
foreach ($file in @('package.json', 'cordis.yml', 'cordis.patch.yml')) {
    Copy-Item (Join-Path $sourceBase ".dsh-home/profiles/workbench/$file") $profile
}
foreach ($dir in @('.agents', 'rules')) {
    Copy-Item -Recurse -Force (Join-Path $sourceBase "workspace/$dir") (Join-Path $base 'workspace')
}
foreach ($file in @('package.json', 'package-lock.json')) {
    Copy-Item (Join-Path $sourceBase $file) $base
}
$packed = & $node $npm pack --silent --pack-destination $cache (Join-Path $sourceBase 'packages/bohack-blueprint')
if ($LASTEXITCODE -ne 0 -or -not $packed) { throw '无法打包工作台插件。' }
Invoke-Checked 'tar.exe' @('-xzf', (Join-Path $cache ($packed | Select-Object -Last 1)), '--strip-components=1', '-C', $plugin)
foreach ($entry in @('README.md', 'package.json', 'package-lock.json', 'WORK', 'scripts', 'skill-packages', 'vendor')) {
    Copy-Item -Recurse -Force (Join-Path $repo "video-kit/$entry") $kit
}
$env:PATH = "$nodeExtract;$env:PATH"
Invoke-Checked $node @($npm, 'ci', '--prefix', $base, '--omit=dev', '--no-audit', '--no-fund')
Invoke-Checked $node @($npm, 'ci', '--prefix', $kit, '--omit=dev', '--no-audit', '--no-fund')

# Git for Windows can check out symlinks as plain text when Developer Mode is off.
$skills = Join-Path $resources '.agents/skills'
New-Item -ItemType Directory -Force $skills | Out-Null
foreach ($name in @('ai-teardown', 'andy-vibe-knowledge', 'huashu-art-motion', 'motion-design-prompt-generator')) {
    $link = (& git -C $repo show "HEAD:.agents/skills/$name").Trim()
    if ($LASTEXITCODE -ne 0 -or -not $link) { throw "无法读取 Skill 路径：$name" }
    $source = [IO.Path]::GetFullPath((Join-Path (Join-Path $repo '.agents/skills') $link))
    if (-not (Test-Path (Join-Path $source 'SKILL.md'))) { throw "Skill 子模块未检出：$name" }
    $destination = Join-Path $skills $name
    New-Item -ItemType Directory -Force $destination | Out-Null
    & robocopy $source $destination /E /XD .git node_modules __pycache__ /XF .DS_Store /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "复制 Skill 失败：$name" }
}
Copy-Item (Join-Path $repo '.project-skills/andy-vibe-knowledge/LICENSE') (Join-Path $skills 'andy-vibe-knowledge/LICENSE')
Copy-Item (Join-Path $repo '.project-skills/andy-vibe-knowledge/LICENSE') (Join-Path $skills 'ai-teardown/LICENSE')
Copy-Item (Join-Path $repo '.project-skills/deepseek-opus-motion-skill/LICENSE') (Join-Path $skills 'motion-design-prompt-generator/LICENSE')
Copy-Item (Join-Path $repo 'desktop/agent.patch.yml') (Join-Path $resources 'desktop-agent.patch.yml')

$browserZip = Join-Path $cache 'chromium-win-1754043.zip'
Get-VerifiedFile 'https://storage.googleapis.com/chromium-browser-snapshots/Win_x64/1754043/chrome-win.zip' $browserZip '0363eaf409db8478a95653f63115615f8ca89cebb5ffc8d503f963f6587da2e9'
$browser = Join-Path $runtime 'browser'
New-Item -ItemType Directory $browser | Out-Null
Invoke-Checked 'tar.exe' @('-xf', $browserZip, '--strip-components=1', '-C', $browser, '--exclude', '*/interactive_ui_tests.exe', '--exclude', '*/setup.exe')
Copy-Item (Join-Path $repo 'desktop/Chromium-LICENSE.txt') (Join-Path $runtime 'browser/Chromium-LICENSE.txt')

# Build codecs from exactly the source archives distributed alongside them.
$sources = Join-Path $codecDir 'sources'
New-Item -ItemType Directory -Force $sources | Out-Null
Get-VerifiedFile 'https://zlib.net/fossils/zlib-1.3.1.tar.gz' (Join-Path $sources 'zlib-1.3.1.tar.gz') '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23'
Get-VerifiedFile 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz' (Join-Path $sources 'ffmpeg-9.0.2.tar.xz') '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
Get-VerifiedFile 'https://download.videolan.org/pub/videolan/x264/snapshots/x264-snapshot-20191217-2245.tar.bz2' (Join-Path $sources 'x264-snapshot-20191217-2245.tar.bz2') '0bb67d095513391e637b3b47e8efc3ba4603c3844f1b4c2690f4d36da7763055'
Get-VerifiedFile 'https://deb.debian.org/debian/pool/main/l/lame/lame_3.100.orig.tar.gz' (Join-Path $sources 'lame-3.100.tar.gz') 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e'
$codecScript = Join-Path $codecDir 'build-codecs.sh'
$codecSource = @'
#!/usr/bin/env bash
set -euo pipefail
root="$(cygpath -u "$JIANGJIE_CODEC_DIR")"
out="$(cygpath -u "$JIANGJIE_CODEC_OUT")"
prefix="$root/prefix"
mkdir -p "$root/build" "$prefix" "$out" "$root/licenses"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
cd "$root/build"
tar xf "$root/sources/zlib-1.3.1.tar.gz"
cd zlib-1.3.1
make -f win32/Makefile.gcc -j2 libz.a
mkdir -p "$prefix/include" "$prefix/lib"
cp zlib.h zconf.h "$prefix/include/"
cp libz.a "$prefix/lib/"
cp LICENSE "$root/licenses/zlib-LICENSE"
cd "$root/build"
tar xf "$root/sources/x264-snapshot-20191217-2245.tar.bz2"
cd x264-snapshot-20191217-2245
./configure --host=x86_64-w64-mingw32 --prefix="$prefix" --enable-static --disable-cli --disable-opencl
make -j2
make install
cp COPYING "$root/licenses/x264-COPYING"
cd "$root/build"
tar xf "$root/sources/lame-3.100.tar.gz"
cd lame-3.100
./configure --prefix="$prefix" --disable-shared --enable-static --disable-frontend
make -j2
make install
cp COPYING "$root/licenses/lame-COPYING"
cd "$root/build"
tar xf "$root/sources/ffmpeg-9.0.2.tar.xz"
cd ffmpeg-9.0.2
./configure --prefix="$prefix" --enable-gpl --enable-libx264 --enable-libmp3lame --enable-zlib --disable-shared --enable-static --disable-ffplay --disable-autodetect --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib -static"
make -j2 ffmpeg.exe ffprobe.exe
cp ffmpeg.exe ffprobe.exe "$out/"
cp COPYING.GPLv2 "$root/licenses/ffmpeg-COPYING.GPLv2"
"$out/ffmpeg.exe" -v error -f lavfi -i color=black:s=64x64:r=10 -f lavfi -i sine=frequency=440 -t 0.2 -c:v libx264 -c:a aac -y "$root/build/smoke.mp4"
"$out/ffprobe.exe" -v error -show_entries format=duration -of default=nw=1 "$root/build/smoke.mp4"
"$out/ffmpeg.exe" -v error -i "$root/build/smoke.mp4" -frames:v 1 -update 1 -y "$root/build/smoke.png"
"$out/ffmpeg.exe" -v error -i "$root/build/smoke.png" -f null -
"$out/ffmpeg.exe" -hide_banner -filters > "$root/build/filters.txt"
for filter in ebur128 freezedetect acompressor; do
  grep -E "[[:space:]]$filter[[:space:]]" "$root/build/filters.txt" > /dev/null
done
"$out/ffmpeg.exe" -v error -f lavfi -i sine=frequency=440 -t 0.2 -c:a libmp3lame -y "$root/build/smoke.mp3"
'@
[IO.File]::WriteAllText($codecScript, ($codecSource -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
$env:JIANGJIE_CODEC_DIR = $codecDir
$env:JIANGJIE_CODEC_OUT = Join-Path $runtime 'ffmpeg'
Invoke-Checked $MsysBash @('-lc', 'bash "$(cygpath -u "$JIANGJIE_CODEC_DIR")/build-codecs.sh"')
$codecSources = Join-Path $resources 'codec-source'
New-Item -ItemType Directory -Force $codecSources | Out-Null
Copy-Item -Recurse $sources, (Join-Path $codecDir 'licenses') $codecSources
Copy-Item $codecScript $codecSources
Copy-Item (Join-Path $PSScriptRoot 'build.ps1') $codecSources

# A second copy dispatches the local DSH CLI for structured scene generation.
Invoke-Checked 'dotnet' @('publish', (Join-Path $PSScriptRoot 'Launcher/Launcher.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', $stage)
Copy-Item (Join-Path $stage 'Jiangjie.exe') (Join-Path $stage 'dsh.exe')
Invoke-Checked $InnoCompiler @("/DSourceDir=$stage", "/DOutputDir=$output", (Join-Path $PSScriptRoot 'installer.iss'))
Write-Host "Windows installer: $(Join-Path $output 'Jiangjie-Windows-x64-0.2.1-setup.exe')"
