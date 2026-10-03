@echo off
setlocal
set "OBS_EXE=%ProgramFiles%\obs-studio\bin\64bit\obs64.exe"

if not exist "%OBS_EXE%" (
  echo OBS was not found at "%OBS_EXE%".
  pause
  exit /b 1
)

powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { if (Get-Process | Where-Object { $_.ProcessName -in @('obs64','obs32','obs') }) { Write-Host 'OBS is already running. Fully quit it, then run Emberstage OBS again.'; exit 2 } } catch { Write-Host 'Could not verify that OBS is closed.'; exit 1 }"
if errorlevel 1 (
  pause
  exit /b 2
)

start "" /D "%ProgramFiles%\obs-studio\bin\64bit" "%OBS_EXE%" --enable-media-stream
