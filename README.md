# macwipe

A quiet, retro Mac cleanup dashboard with separate local cleanup managers.
The website uses HTML, CSS, and vanilla JavaScript and needs no install,
build step, account, or runtime dependencies.

**Use the public demo:** https://macwipe.vercel.app

**Browser demo uses example data only:** it cannot scan your Mac or delete files.
Simulate cleanup clears selections. Chat messages stay in browser memory;
there are no server requests, analytics, or saved chat history.
The landing page includes a native macOS download alongside the browser demo.

## Preview

<table>
  <tr>
    <td><a href="docs/screenshots/landing.png"><img src="docs/screenshots/landing.png" width="320" alt="macwipe landing page"></a><br></td>
    <td><a href="docs/screenshots/chat.png"><img src="docs/screenshots/chat.png" width="320" alt="mac-chat with a local message"></a><br></td>
  </tr>
  <tr>
    <td><a href="docs/screenshots/dashboard.png"><img src="docs/screenshots/dashboard.png" width="320" alt="Storage dashboard with example items"></a><br></td>
    <td><a href="docs/screenshots/review.png"><img src="docs/screenshots/review.png" width="320" alt="Selected items and simulate cleanup dialog"></a><br></td>
  </tr>
</table>

Click a preview to view the larger image.

## Download and run locally

Requires a recent browser. On macOS:

```sh
git clone https://github.com/julsoyola/macwipe.git
cd macwipe
open website/index.html
```

Or use GitHub's **Code → Download ZIP**, unzip it, and open
`website/index.html`. This repository is private, so sign in with an account
that has access. For HTTPS cloning, use your GitHub credential manager or
`gh auth login`; GitHub account passwords do not authenticate Git operations.
After downloading, the demo works offline.

## Try the demo

1. Click **Launch Web Dashboard Demo**.
2. Choose a category and click **Preview scan** or **Details**.
3. Select individual items or **Select all**.
4. Click **Review selected → Simulate cleanup** to reset selections.
5. On the landing page, open an FAQ and send a local message using Send or Enter.

## Files

- `website/`: the standalone website, styling, assets, and dashboard UI.
- `website/macwipe-bridge.js`: the UI adapter for the Swift native bridge.
- `native/`: the Swift WKWebView wrapper and filesystem manager.
- `mac_scrubber/`: the separate Python CLI manager and local helper scaffold.
- `tests/`: Python safety/runtime tests and browser demo checks.
- `.github/workflows/tests.yml`: Python tests on macOS.
- `docs/screenshots/`: small README previews.

Website hosting includes only `website/`. Swift and Python manager code stays
outside the website. Generated `.app` bundles and build output are ignored.

## Native dashboard

Requires macOS 13 or newer and the Xcode command-line tools. Build and launch:

```sh
./native/build.sh --launch
```

All seven native tabs scan real local paths: Storage, Caches, Downloads,
Applications, Startup, Performance, and Privacy. Native rows support file
selection and review, and confirmed selections move to Trash. Downloads are
eligible only when they are top-level regular files not modified in over
30 days; folders, symlinks, and recent files stay in place. Trash is shown
as a total and is never emptied. Unreadable entries are skipped without
disabling accessible siblings. Empty tabs contain no example data.

Applications include installed apps and unmatched application-support
candidates; unmatched names do not prove a folder is orphaned. Startup covers
user and system launch plists. Performance covers system logs and diagnostic
reports. Privacy covers Safari traces and Safari/Chrome history and cookies,
excluding bookmarks and password stores. Review these paths carefully and
close affected apps before confirming. Moving startup plists does not stop
already-running services. System and browser permissions still apply.

Moving files to Trash does not free disk space. The completion dialog reports
space moved separately from actual disk space freed, then the native manager
rescans. Filesystem permissions can prevent scanning or cleanup.

See [native/README.md](native/README.md) for source and build details. The ZIP
uses an ad-hoc development signature and is not notarized; macOS may block
launching a downloaded build.

## Package the macOS download

On macOS with the Xcode command-line tools installed, run:

```sh
./native/package.sh
```

The script rebuilds a universal app for Intel and Apple silicon, stages a clean
release copy, and verifies its signature and both architectures after unzipping.
It produces `native/release/macwipe-macos.zip` and copies the same ZIP to
`website/downloads/macwipe-macos.zip`, the landing page's download target.
Re-run it after changing Swift or website assets. Include the website ZIP when
publishing `website/`; native release staging stays ignored by Git. Packaging
does not launch the app or perform cleanup.

## Python manager

Requires Python 3.9 or newer on macOS; it uses the standard library only.
Run from the repository root:

```sh
python3.11 -m mac_scrubber --help
python3.11 -m mac_scrubber scan --section Caches --json
python3.11 -m mac_scrubber interactive --dry-run
```

Scanning is read-only. Plans require explicit candidate IDs. Real execution
requires an interactive terminal and the exact confirmation phrase shown by
the manager; JSON output cannot bypass confirmation.

Supported cleanup candidates are individual top-level Downloads files, pip's
`Library/Caches/pip/http-v2` and `Library/Caches/pip/wheels` directories, and
Homebrew cleanup with a reviewed dry-run. Python Downloads selection does not
use the Swift manager's 30-day modification filter. Files and pip caches move to Trash;
Homebrew cleanup can permanently remove stale downloads and old versions.
Applications and startup settings are inventory/manual review only.

The Python loopback helper is a scaffold: its separate `mac_scrubber/ui/`
assets are not included, so it does not yet provide a usable browser manager.
The website's native bridge connects to Swift, not the Python helper.

## Development and tests

```sh
python3.11 -m unittest discover -s tests -v
python3 tests/native-tests.py
./native/build.sh
python3 tests/native-tests.py --ui
git diff --check
```

Browser checks use Playwright and Google Chrome. Keep test dependencies outside
the repository; the website itself has no Node dependency:

```sh
MACWIPE_TEST_TOOLS="$(mktemp -d /tmp/macwipe-test-tools.XXXXXX)"
npm install --prefix "$MACWIPE_TEST_TOOLS" playwright
NODE_PATH="$MACWIPE_TEST_TOOLS/node_modules" node tests/web-demo.cjs
NODE_PATH="$MACWIPE_TEST_TOOLS/node_modules" node tests/native-dashboard.cjs
```

The browser test expects Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and writes
screenshots to a temporary directory. Python tests use fixtures and mocked
commands; do not test cleanup against personal files.

See [CONTRIBUTING.md](CONTRIBUTING.md) for cleanup rules and review requirements.
MIT license.

## Hosting

Hosted on Vercel as a static site. Deploy the `website/` directory;
`website/vercel.json` defines the configuration. No build step is needed.
