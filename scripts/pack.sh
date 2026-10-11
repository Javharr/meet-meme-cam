#!/usr/bin/env sh
# Builds dist/meet-meme-cam-<version>.zip from extension/ —
# the archive you attach to a GitHub release or upload to the Chrome Web Store.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' extension/manifest.json | head -n 1)
mkdir -p dist
out="dist/meet-meme-cam-${version}.zip"
rm -f "$out"
(cd extension && zip -qr -X "../$out" . -x '*.DS_Store' -x '*/README.md' -x 'README.md')
echo "$out"
