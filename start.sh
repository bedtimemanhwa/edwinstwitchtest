#!/bin/sh
# macOS / Linux launcher: installs and builds on first run (source download only), then starts the server
# and opens the dashboard. Windows users: double-click start-windows.bat instead.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run this again."
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Hulk's Hangout needs Node.js 22.13 or newer (you have $(node -v)). Install Node.js 22 LTS from https://nodejs.org."
  exit 1
fi
[ -d node_modules ] || { echo "First run: installing dependencies..."; npm install; }
[ -f dist/server/server/main.js ] || { echo "Building Hulk's Hangout..."; npm run build; }
echo "Keep this window open while you stream. Press Ctrl+C to stop."
HH_OPEN_BROWSER=1 exec node --no-warnings=ExperimentalWarning dist/server/server/main.js
