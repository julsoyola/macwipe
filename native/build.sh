#!/bin/sh
set -eu

NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$NATIVE_DIR")
APP_DIR="$NATIVE_DIR/build/macwipe.app"

plutil -lint "$NATIVE_DIR/Info.plist"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources/Web"
swiftc -target "$(uname -m)-apple-macosx13.0" \
  -framework Cocoa -framework WebKit \
  "$NATIVE_DIR/main.swift" "$NATIVE_DIR/ViewController.swift" \
  -o "$APP_DIR/Contents/MacOS/macwipe"
cp "$NATIVE_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"
cp -R "$PROJECT_DIR/website/." "$APP_DIR/Contents/Resources/Web/"
cp "$NATIVE_DIR/Web/macwipe-bridge.js" "$APP_DIR/Contents/Resources/Web/macwipe-bridge.js"
printf 'Built %s\n' "$APP_DIR"
