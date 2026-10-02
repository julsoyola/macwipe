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
- `build.sh`: compiles Swift, copies website resources, signs with
  `macwipe.entitlements`, and verifies the resulting bundle.
- `package.sh`: builds a universal app, verifies the ZIP, and copies it to the
  website's download directory. Run `./native/package.sh` from the repo root.

From the repository root, with the Xcode command-line tools installed:

```sh
./native/build.sh --launch
```

Builds go to `native/build/macwipe.app`, which is ignored by Git. The build
does not launch the app, scan files, or perform cleanup. Launching the app
starts a local scan. The build uses an ad-hoc development signature with the
entitlements in this directory; it is not signed for distribution or notarized.
Use `./native/build.sh --universal` to build both Intel and Apple silicon
architectures without packaging. App resources exclude `website/downloads/`
to keep release ZIPs out of the bundled website.

| Tab | Local scan paths |
| --- | --- |
| Storage | Overview of Caches, Logs, Trash totals, and stale Downloads |
| Caches | `~/Library/Caches` |
| Downloads | Top-level regular files not modified in over 30 days in `~/Downloads` |
| Applications | `/Applications`, `~/Applications`, unmatched folders in `~/Library/Application Support` |
| Startup | `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons` |
| Performance | `/var/log`, `~/Library/Logs/DiagnosticReports` |
| Privacy | Safari history/session/storage traces, cookie stores, and Chrome profile history/cookies |

Native mode contains no fallback example rows. Every emitted item has an ID,
category, absolute path, name, byte count, formatted size, and `canClean: true`.
Unreadable entries are skipped; accessible siblings remain selectable. A
partly unreadable directory is not approved wholesale, and unreadable apps are
skipped. Trash is read-only and is never emptied.

Application-support names are compared with installed app names, bundle IDs,
and vendor components. Unmatched folders are candidates for review, not proven
orphans. They can contain personal data. Applications are moved to Trash;
this does not run vendor uninstallers or remove all supporting files. Startup
cleanup moves selected plist files; it does not unload active services.
Privacy scanning excludes bookmarks and password stores. Close affected apps
and browsers before confirming cleanup.

Cleanup accepts only paths approved by the latest scan and rechecks their
identity and contents before moving them to Trash. Changed files are rejected.
Overlapping selections move a parent folder only once. Logical file bytes are
not reclaimable disk space; moving to Trash does not reclaim disk space.
Signing does not grant administrator permissions or Full Disk Access;
restricted system and browser paths may remain unavailable.

Run fixture-only native checks without touching personal files:

```sh
python3 tests/native-tests.py
./native/build.sh
python3 tests/native-tests.py --ui
```

The UI check loads the built web resources into a real WKWebView with temporary
scan roots and a stub Trash operation, verifies all tabs, and exercises review,
cleanup callbacks, and the subsequent rescan.
