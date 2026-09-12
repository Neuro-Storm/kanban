#!/usr/bin/env bash
# Смоук-тест: запускает Electron под виртуальным дисплеем и прогоняет
# сценарий проверки в настоящем рендерере (сборка доски, перетаскивание,
# правка, удаление с возвратом, поиск, WIP-лимиты, автосохранение).
set -euo pipefail
cd "$(dirname "$0")/.."

ELECTRON_BIN="./node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron не установлен — сначала выполни: npm install" >&2
  exit 2
fi

ARGS=(. --smoke --no-sandbox --disable-gpu)

if command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a "$ELECTRON_BIN" "${ARGS[@]}"
else
  exec "$ELECTRON_BIN" "${ARGS[@]}"
fi
