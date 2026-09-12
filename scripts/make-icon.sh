#!/usr/bin/env bash
# Векторная иконка приложения: три стикера на доске.
# Из SVG делаем PNG (256 и 512) через rsvg-convert.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build

cat > build/icon.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#efe8da"/>
      <stop offset="1" stop-color="#ddd2bd"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#4d4231" flood-opacity="0.24"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#bg)"/>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="none" stroke="#b9ab90" stroke-width="3"/>

  <g filter="url(#soft)">
    <rect x="34" y="56" width="56" height="122" rx="10" fill="#f2dc8a" transform="rotate(-3 62 117)"/>
    <rect x="100" y="44" width="56" height="146" rx="10" fill="#bfe2c3" transform="rotate(1.6 128 117)"/>
    <rect x="166" y="62" width="56" height="112" rx="10" fill="#f3cda2" transform="rotate(-1.2 194 118)"/>
  </g>

  <g stroke="#5c5240" stroke-opacity="0.5" stroke-width="7" stroke-linecap="round">
    <line x1="46" y1="84" x2="78" y2="84"/>
    <line x1="46" y1="102" x2="78" y2="102"/>
    <line x1="46" y1="120" x2="70" y2="120"/>
    <line x1="112" y1="74" x2="144" y2="74"/>
    <line x1="112" y1="92" x2="144" y2="92"/>
    <line x1="112" y1="110" x2="136" y2="110"/>
    <line x1="178" y1="90" x2="210" y2="90"/>
    <line x1="178" y1="108" x2="210" y2="108"/>
  </g>
</svg>
SVG

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 256 -h 256 build/icon.svg -o build/icon.png
  rsvg-convert -w 512 -h 512 build/icon.svg -o build/icon-512.png
  echo "Иконка собрана: build/icon.png, build/icon-512.png"
else
  echo "rsvg-convert не найден — установи librsvg2-bin" >&2
  exit 2
fi
