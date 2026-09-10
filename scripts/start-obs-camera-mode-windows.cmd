@echo off
setlocal
set "OBS_EXE=%ProgramFiles%\obs-studio\bin\64bit\obs64.exe"

if not exist "%OBS_EXE%" (
  echo OBS was not found at "%OBS_EXE%".
  exit /b 1
)

tasklist /FI "IMAGENAME eq obs64.exe" 2>NUL | find /I "obs64.exe" >NUL
if not errorlevel 1 (
  echo OBS is already running. Fully quit it, then run this launcher again.
  exit /b 2
)

start "" "%OBS_EXE%" --enable-media-stream
