# Native manager

This directory contains the macOS 13+ Swift WKWebView wrapper and filesystem
manager. Frontend pages, styles, and dashboard rendering stay in `../website/`;
the independent Python manager stays in `../mac_scrubber/`.

- `ViewController.swift`: loads the dashboard, handles bridge messages, scans
  files, and validates confirmed selections before moving files to Trash.
- `main.swift`: app entry point and window setup.
- `Info.plist`: app metadata and Downloads access description.
- `Web/macwipe-bridge.js`: injected UI bridge, mirrored in
  `../website/macwipe-bridge.js` for explicit HTML script loading.
- `build.sh`: compiles Swift and copies website resources into a local bundle.

From the repository root, with the Xcode command-line tools installed:

```sh
./native/build.sh
open native/build/macwipe.app
```

Builds go to `native/build/macwipe.app`, which is ignored by Git. The build
does not launch the app, scan files, or perform cleanup. Launching the app
starts a local scan. This development build is not signed for distribution
or notarized.

Swift scans `~/Library/Caches`, `~/Library/Logs`, `~/.Trash`, and `~/Downloads`.
Downloads cleanup covers only top-level regular files older than 90 days.
Trash is read-only and provides a category total, not individual file rows.
Scans report logical file bytes. Cleanup moves approved files to Trash and
does not reclaim disk space. Permission errors disable cleanup for affected
categories; changed files are rejected and require another scan.
