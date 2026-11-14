@echo off
setlocal
rem Recreate the two profile junctions that a plain file copy cannot carry.
rem Both profiles mount the local @bohack/blueprint package via a directory
rem junction; run this once after cloning/copying the base, before first boot.
set "BASE=%~dp0"

if not exist "%BASE%.dsh-home\profiles\bohack\node_modules\@bohack" mkdir "%BASE%.dsh-home\profiles\bohack\node_modules\@bohack"
if not exist "%BASE%.dsh-home\profiles\bohack\node_modules\@bohack\blueprint" (
  mklink /J "%BASE%.dsh-home\profiles\bohack\node_modules\@bohack\blueprint" "%BASE%packages\bohack-blueprint"
) else (
  echo [ok] bohack profile junction already present
)

if not exist "%BASE%.dsh-home\profiles\workbench\node_modules\@bohack" mkdir "%BASE%.dsh-home\profiles\workbench\node_modules\@bohack"
if not exist "%BASE%.dsh-home\profiles\workbench\node_modules\@bohack\blueprint" (
  mklink /J "%BASE%.dsh-home\profiles\workbench\node_modules\@bohack\blueprint" "%BASE%packages\bohack-blueprint"
) else (
  echo [ok] workbench profile junction already present
)

echo done.
endlocal
