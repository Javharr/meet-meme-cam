#!/usr/bin/env sh
# Quick sanity checks, the same ones CI runs. Needs Node.js 18+ and zip.
set -eu
cd "$(dirname "$0")/.."

echo "· JSON"
for f in extension/manifest.json extension/_locales/*/messages.json; do
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$f"
done

echo "· JavaScript syntax"
for f in extension/*.js; do
  case "$f" in */detector.frame.js) continue ;; esac   # ES module — checked below
  node --check "$f"
done
tmp=$(mktemp -d) && cp extension/detector.frame.js "$tmp/detector.frame.mjs" && node --check "$tmp/detector.frame.mjs"

echo "· files referenced by manifest.json"
node -e '
const fs = require("fs"), path = require("path");
const m = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const files = [
  ...m.content_scripts.flatMap((c) => c.js),
  m.action.default_popup,
  ...Object.values(m.icons),
  ...m.web_accessible_resources.flatMap((w) => w.resources).filter((r) => !r.includes("*")),
];
const missing = files.filter((f) => !fs.existsSync(path.join("extension", f)));
for (const d of ["models/face_landmarker.task", "models/gesture_recognizer.task",
  "models/selfie_segmenter_landscape.tflite", "vendor/vision_bundle.mjs"]) {
  if (!fs.existsSync(path.join("extension", d))) missing.push(d);
}
if (missing.length) { console.error("missing:", missing.join(", ")); process.exit(1); }
'
echo "ok"
