#!/usr/bin/env bash
# Снимает кадр приложения для README.
# Результат: artifacts/preview.png
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

echo "Кадр: artifacts/preview.png"
