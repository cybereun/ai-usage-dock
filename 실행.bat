@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run npm install in this folder first.
  pause
  exit /b
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."

