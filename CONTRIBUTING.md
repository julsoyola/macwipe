# Contributing

Keep Macwipe small, local, and read-only until the user confirms an action.

## Before changing code

Read the existing code and tests. Keep changes focused.

Test cleanup with temporary folders and mocked macOS commands. Never test deletion on your actual files.

Run:

    python3.11 -m unittest discover -s tests -v
    git diff --check

## Website changes

Keep the two canonical pages in `website/`, shared CSS in `website/styles/`,
and browser scripts in `website/scripts/`. Existing `_2.html` URLs are redirects.
Do not add another copy of a page or a second palette. Author messenger markup
in `scripts/ui.js`; fill dynamic content with `textContent`.

Preserve the offline demo boundary: example data never invokes the native API.
Keep filesystem operations and confirmation checks in the manager layers:
`mac_scrubber/` for Python and `native/` for Swift. The website's WKWebView
bridge connects only to Swift; the Python loopback helper has no UI assets yet.
Build the native app with `./native/build.sh`; do not commit generated bundles.
Keep `website/macwipe-bridge.js` and `native/Web/macwipe-bridge.js` in sync.

Cache stable DOM references, delegate dynamic-row events, and update selection
state without rebuilding rows. Batch category/review updates in fragments.
Do not add idle polling, perpetual animations, animated paint properties, or
persistent `will-change` hints. Respect `prefers-reduced-motion`.

Run the browser checks using the exact commands under Development and tests
in README.md. Inspect desktop and mobile screenshots. The test dependency
belongs outside the repository; the website needs no Node runtime or build.

## Add a cleanup rule

Add a `Rule` entry in `mac_scrubber/rules.py`. The CLI discovers it automatically.

Each rule needs:

- A unique, stable ID.
- A clear description of what it removes.
- An exact home-relative cache path or supported command argument list.
- Vendor documentation confirming the target is disposable.
- The supported app versions and folder layout.
- The consequences of cleanup.
- Any apps that must be closed first.

A folder named “cache” is not enough evidence to delete it.

If a target might contain settings, profiles, passwords, databases, extensions, editor state, game saves, mods, or personal files, show it for manual review instead.

Never target protected or shared parent folders, Apple services, security tools, or device-management agents.

## Rules that remove folders

Move only the validated disposable folder to Trash.

Check ownership and scope. Do not follow symlinks. Keep scans bounded.

Test that the rule cannot affect parent folders, sibling folders, or unrelated files. Recheck the target immediately before cleanup.

## Rules that run commands

Use argument lists, never `shell=True`.

A command must have:

- A documented read-only preview.
- A time limit.
- A verified executable that has not changed.
- A preview that has not changed since review.
- A documented way to check the result.

The current executor supports Homebrew-style `--dry-run` behavior only. Other tools need their own reviewed preview and verification adapter.

Never run a discovered script automatically or guess uninstaller arguments.

## Check whether apps are closed

Identify processes by verified executable paths. Do not match words in command arguments.

Explain any gaps in the check, including unknown processes, custom runtimes, or apps restarting during cleanup. If you cannot confidently identify a required app, block cleanup.

## Keep these limits

- Require explicit confirmation before changes.
- Dry-run and cancellation must not change files.
- Never collect passwords or silently use `sudo`.
- Never force a restart.
- Do not add app removal or startup changes without separately reviewed identity checks and recovery behavior. Version 1 does not support these actions.

## Required tests

Cover:

- Finding only the documented target.
- Missing tools, denied permissions, and unsupported OS features.
- Confirmation, cancellation, and dry-run.
- Absolute paths, ownership, and protected folders.
- Symlinks in targets or parent paths, including links changed after scanning.
- Hard links, spaces, Unicode, and terminal-control characters.
- Exact process matching, running apps, and incomplete process lists.
- Changes to the target, executable, or preview before cleanup.
- Trash name collisions, failed actions, and partial success.
- Measured free space, without promises of faster performance.
- Consistent CLI and JSON results without exposing private information.

## Finish the change

Update the README with supported rules and limitations.

Review the diff and run the tests and whitespace check.

Publish or push only when explicitly authorized.
