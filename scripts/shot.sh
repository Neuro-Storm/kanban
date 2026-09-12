#!/usr/bin/env bash
# Снимает кадры приложения для README: доску и открытый редактор стикера.
# Результат: artifacts/preview.png и artifacts/preview-editor.png
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON_BIN="./node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron не установлен — сначала выполни: npm install" >&2
  exit 2
fi

mkdir -p artifacts

KANBAN_SHOT="$(pwd)/artifacts/preview.png" \
  xvfb-run -a "$ELECTRON_BIN" . --shot --no-sandbox --disable-gpu

KANBAN_SHOT="$(pwd)/artifacts/preview-editor.png" \
  xvfb-run -a "$ELECTRON_BIN" . --shot-editor --no-sandbox --disable-gpu

echo "Кадры: artifacts/preview.png, artifacts/preview-editor.png"
