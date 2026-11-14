@echo off
setlocal
rem Isolated BoHack base. No fallback to the desktop CLI: nightly would drift.
set "DSH_HOME=%~dp0.dsh-home"
set "TARGET=0.2.2-rc.1"
set "CLI=%~dp0node_modules\.bin\dsh.cmd"
rem Optional local Node 24 binary (binary only, no DSH config or sessions).
set "NODE24=C:\Users\24178\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
if exist "%NODE24%\node.exe" set "PATH=%NODE24%;%PATH%"
node -e "const v=process.versions.node.split('.').map(Number);process.exit((v[0]>24||(v[0]===24&&v[1]>=9))?0:1)"
if errorlevel 1 (
  echo [bohack-base] ERROR: Node 24.9.0 or newer required. Current version:
  node -v
  exit /b 1
)
if not exist "%CLI%" (
  echo [bohack-base] ERROR: local DSH CLI missing at %CLI%
  echo [bohack-base] Run: npm install --prefix "%~dp0." --registry=https://registry.npmmirror.com
  exit /b 1
)
call "%CLI%" --version > "%TEMP%\bohack-dsh-ver.txt"
set /p GOT=<"%TEMP%\bohack-dsh-ver.txt"
if not "%GOT%"=="%TARGET%" (
  echo [bohack-base] ERROR: got %GOT%, expected %TARGET%. Do not fall back.
  exit /b 1
)
call "%CLI%" web %*
endlocal
