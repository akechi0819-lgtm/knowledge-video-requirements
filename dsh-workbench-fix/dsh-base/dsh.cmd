@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
if not defined JIANGJIE_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "JIANGJIE_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined JIANGJIE_NODE set "JIANGJIE_NODE=node.exe"
"%JIANGJIE_NODE%" "%~dp0start-dsh.mjs" --cli %*
exit /b %ERRORLEVEL%
