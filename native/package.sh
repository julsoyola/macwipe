#!/bin/sh
set -eu

NATIVE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$NATIVE_DIR")
RELEASE_DIR="$NATIVE_DIR/release"
DOWNLOAD_DIR="$PROJECT_DIR/website/downloads"
APP_DIR="$NATIVE_DIR/build/macwipe.app"

# Always rebuild so the archive contains current Swift and web assets.
"$NATIVE_DIR/build.sh" --universal
mkdir -p "$RELEASE_DIR" "$DOWNLOAD_DIR"
PACKAGE_DIR=$(mktemp -d "$RELEASE_DIR/.package.XXXXXX")
trap 'rm -rf "$PACKAGE_DIR"' EXIT
trap 'exit 1' HUP INT TERM

ditto "$APP_DIR" "$PACKAGE_DIR/macwipe.app"
codesign --verify --deep --strict "$PACKAGE_DIR/macwipe.app"
lipo "$PACKAGE_DIR/macwipe.app/Contents/MacOS/macwipe" -verify_arch arm64 x86_64
ditto -c -k --sequesterRsrc --keepParent \
  "$PACKAGE_DIR/macwipe.app" "$PACKAGE_DIR/macwipe-macos.zip"

# Check the actual archive before replacing either download artifact.
ditto -x -k "$PACKAGE_DIR/macwipe-macos.zip" "$PACKAGE_DIR/verify"
codesign --verify --deep --strict "$PACKAGE_DIR/verify/macwipe.app"
lipo "$PACKAGE_DIR/verify/macwipe.app/Contents/MacOS/macwipe" -verify_arch arm64 x86_64
mv "$PACKAGE_DIR/macwipe-macos.zip" "$RELEASE_DIR/macwipe-macos.zip"
cp "$RELEASE_DIR/macwipe-macos.zip" "$DOWNLOAD_DIR/macwipe-macos.zip"
printf 'Release archive: %s\nWebsite download: %s\n' \
  "$RELEASE_DIR/macwipe-macos.zip" "$DOWNLOAD_DIR/macwipe-macos.zip"
