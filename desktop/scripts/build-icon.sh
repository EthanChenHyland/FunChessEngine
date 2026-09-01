#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/.." && pwd)"
SOURCE="$ROOT_DIR/gui/static/app-mark.svg"
WORK_DIR="$DESKTOP_DIR/.cache/icon-build"
ICONSET="$WORK_DIR/icon.iconset"
PREVIEW_DIR="$WORK_DIR/preview"

rm -rf "$WORK_DIR"
mkdir -p "$ICONSET" "$PREVIEW_DIR" "$DESKTOP_DIR/assets"

qlmanage -t -s 1024 -o "$PREVIEW_DIR" "$SOURCE" >/dev/null 2>&1
PNG="$PREVIEW_DIR/app-mark.svg.png"
cp "$PNG" "$DESKTOP_DIR/assets/icon.png"

while read -r size name; do
  sips -z "$size" "$size" "$PNG" --out "$ICONSET/$name" >/dev/null
done <<'SIZES'
16 icon_16x16.png
32 icon_16x16@2x.png
32 icon_32x32.png
64 icon_32x32@2x.png
128 icon_128x128.png
256 icon_128x128@2x.png
256 icon_256x256.png
512 icon_256x256@2x.png
512 icon_512x512.png
1024 icon_512x512@2x.png
SIZES

iconutil -c icns "$ICONSET" -o "$DESKTOP_DIR/assets/icon.icns"
rm -rf "$WORK_DIR"
echo "Desktop icon ready: $DESKTOP_DIR/assets/icon.icns"
