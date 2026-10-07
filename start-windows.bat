@echo off
setlocal
title Hulk's Hangout
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install Node.js 22 LTS from https://nodejs.org and then double-click this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Your Node.js is too old. Hulk's Hangout needs Node.js 22.13 or newer.
  echo Install Node.js 22 LTS from https://nodejs.org and then double-click this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies. This takes a minute or two.
  call npm install || goto failed
)
if not exist "dist\server\server\main.js" (
  echo Building Hulk's Hangout...
  call npm run build || goto failed
)

set HH_OPEN_BROWSER=1
echo.
echo Keep this window open while you stream. Close it to stop Hulk's Hangout.
echo.
node --no-warnings=ExperimentalWarning dist\server\server\main.js
echo.
echo Hulk's Hangout has stopped.
pause
exit /b 0

:failed
echo.
echo Setup failed. Scroll up to see the error.
pause
exit /b 1
