#!/bin/sh
# Builds the ready-to-run download: HulksHangout.zip with the built app and its runtime dependencies,
# so the streamer only needs Node.js installed (no npm install, no build). Used by .github/workflows/release.yml.
#   npm ci && npm run build && sh scripts/package.sh
set -e
OUT=release/HulksHangout
rm -rf release
mkdir -p "$OUT/docs"
cp -R dist "$OUT/dist"
cp package.json package-lock.json README.md .env.example start-windows.bat start.sh "$OUT/"
cp docs/ASSETS.md docs/VERIFICATION.md "$OUT/docs/"
cp -R docs/screenshots "$OUT/docs/screenshots"
(cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && find node_modules -type d -empty -delete)
(cd release && zip -qr HulksHangout.zip HulksHangout)
echo "Wrote release/HulksHangout.zip ($(du -h release/HulksHangout.zip | cut -f1))"
