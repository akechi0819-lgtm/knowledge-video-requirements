@echo off
setlocal
rem BoHack workbench: single DSH instance running BOTH capability sessions —
rem requirement dialogue (standard preset + teammate tool face via the profile
rem patch layer) and blueprint (preset-blueprint, narrow tool face). Serves the
rem ink-shell temp UI at /bohack/. cwd is pinned to this base so the relative
rem `workspace` in cordis.patch.yml resolves deterministically.
pushd "%~dp0"
call "%~dp0dsh.cmd" workbench %*
set "RC=%ERRORLEVEL%"
popd
endlocal & exit /b %RC%
