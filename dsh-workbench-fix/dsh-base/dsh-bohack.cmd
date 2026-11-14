@echo off
setlocal
rem BoHack A: boot the `bohack` profile (web composition + @bohack/blueprint)
rem with the temporary /bohack UI. cwd is pinned to this base so that the
rem relative `workspace` in cordis.patch.yml resolves deterministically.
pushd "%~dp0"
call "%~dp0dsh.cmd" bohack %*
set "RC=%ERRORLEVEL%"
popd
endlocal & exit /b %RC%
