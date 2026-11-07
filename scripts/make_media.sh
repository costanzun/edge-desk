#!/usr/bin/env bash
# Turn the Playwright demo recording (docs/media/raw/*.webm) into docs/media/demo.mp4 and demo.gif.
#   scripts/make_media.sh [path/to/recording.webm]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IN="${1:-$(ls -t "$ROOT"/docs/media/raw/*.webm | head -1)}"
OUT="$ROOT/docs/media"
mkdir -p "$OUT"
ffmpeg -y -loglevel error -i "$IN" -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart \
  -vf "scale=1440:-2" "$OUT/demo.mp4"
# GIF: 10 fps, 960 px wide, two-pass palette; first ~45 s so it stays README-friendly
ffmpeg -y -loglevel error -t 32 -i "$IN" -vf "fps=6,scale=720:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/edge_palette.png
ffmpeg -y -loglevel error -t 32 -i "$IN" -i /tmp/edge_palette.png \
  -lavfi "fps=6,scale=720:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a:diff_mode=rectangle" "$OUT/demo.gif"
ls -lh "$OUT/demo.mp4" "$OUT/demo.gif"
