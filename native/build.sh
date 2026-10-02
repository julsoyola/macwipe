#!/bin/sh
set -eu

NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$NATIVE_DIR")
APP_DIR="$NATIVE_DIR/build/macwipe.app"
ARCHITECTURES="$(uname -m)"
LAUNCH=0

for option in "$@"; do
  case "$option" in
    --launch) LAUNCH=1 ;;
    --universal) ARCHITECTURES="arm64 x86_64" ;;
    *) printf 'Usage: %s [--universal] [--launch]\n' "$0" >&2; exit 2 ;;
  esac
done

plutil -lint "$NATIVE_DIR/Info.plist"
plutil -lint "$NATIVE_DIR/macwipe.entitlements"
cmp "$NATIVE_DIR/Web/macwipe-bridge.js" "$PROJECT_DIR/website/macwipe-bridge.js"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources/Web"
BUILD_DIR=$(mktemp -d "$NATIVE_DIR/build/.compile.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT
trap 'exit 1' HUP INT TERM
for architecture in $ARCHITECTURES; do
  swiftc -target "$architecture-apple-macosx13.0" \
    -framework Cocoa -framework WebKit \
    "$NATIVE_DIR/main.swift" "$NATIVE_DIR/ViewController.swift" \
    -o "$BUILD_DIR/macwipe-$architecture"
done
lipo -create "$BUILD_DIR"/macwipe-* -output "$APP_DIR/Contents/MacOS/macwipe"
cp "$NATIVE_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"
ICONSET_DIR="$BUILD_DIR/macwipe.iconset"
mkdir -p "$ICONSET_DIR"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$NATIVE_DIR/Assets/macwipe-icon.png" \
    --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  sips -z "$double_size" "$double_size" "$NATIVE_DIR/Assets/macwipe-icon.png" \
    --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET_DIR" -o "$APP_DIR/Contents/Resources/macwipe.icns"
cp "$NATIVE_DIR/Assets/macwipe-icon.png" "$APP_DIR/Contents/Resources/macwipe-icon.png"
# Only generated web resources are synchronized; release ZIPs stay outside.
rsync -a --delete --delete-excluded \
  --exclude '/downloads/' --exclude '/.vercel/' --exclude '.DS_Store' \
  "$PROJECT_DIR/website/" "$APP_DIR/Contents/Resources/Web/"
cp "$NATIVE_DIR/Web/macwipe-bridge.js" "$APP_DIR/Contents/Resources/Web/macwipe-bridge.js"
codesign --force --sign - --entitlements "$NATIVE_DIR/macwipe.entitlements" "$APP_DIR"
codesign --verify --deep --strict "$APP_DIR"
printf 'Built %s\n' "$APP_DIR"
if [ "$LAUNCH" -eq 1 ]; then
  open -n "$APP_DIR"
fi
