# MacWipe feature demo video

Records the real local `website/dashboard.html` with example data. It does not
launch the native app, access real user files, or request recording permission.

The reusable renderer is a separate sibling checkout, `../project-demo-video`.
Set `DEMO_VIDEO_TOOL` to use another location. It reuses the earlier recording
workflow's safe subprocess, diagnostic, and offline export patterns without
including any OAuth, account, Chrome-profile or Drive-fixture code.

```sh
bash demo-video/start.sh --check
bash demo-video/start.sh
```

Output: `~/Downloads/MacWipe-Feature-Demo-<timestamp>.mp4`. The result is an 84-second,
1920×1080, 30 fps, silent H.264 MP4. The 1600×900 viewport is not stretched.
Cards/captions use the exact palette from `website/styles/theme.css` and its
existing `assets/disk.svg`. Production UI styles and behavior are untouched.

`sequence.json` contains every caption, scene boundary, and action timestamp.
`record.mjs` contains the source-specific navigation and assertions. A fresh
context starts every attempt so previous Keep preferences cannot affect it.
Only loopback requests are allowed. There are no manual checkpoints.

The rehearsal and recording assert explorer contents, descending size order,
Keep exclusion, actual checkbox states across categories, the exact two-item
review, its 505 MB example total, the visible simulation notice, and selection
reset without removing rows or changing capacity. Select all is never used.

Ignored `.local/<run>/temp/` folders hold generated media during a run.
Validated success automatically trashes raw footage and temporary output.
Failures keep diagnostic and resume evidence. Each normal start uses a
unique Downloads filename, preserving all previous exports. Raw Playwright
cadence is normalized to the requested 30 fps on final export. Format,
full decode, duration and browser playback/seeking are verified before
cleanup. Inspect the actual final MP4 before sharing.

## Source-copy difference

The current `itemDetails()` renderer prefers shared category descriptions over
`demo-data.js` item-specific details. The real cache dialog therefore says
apps may recreate cached files and to close affected apps; it does **not**
display the example's slower-next-load sentence. The recorder preserves this
real dialog and the requested captions. That unmet copy detail is retained
in the sequence and review report. It is not patched into production or
replaced by a fabricated screenshot. Native cache bulk-selection behavior is
not demonstrated or claimed.

No generated media, browser data or personal configuration is tracked.
Nothing commits, pushes, deploys, uploads, publishes or submits the video.


## Local output retention

A normal start makes a fresh recording and saves a uniquely timestamped MP4
in Downloads. Existing videos are preserved; no rename or finalization step
is needed. Google consent and file-action checkpoints remain manual.

Each run owns a private `.local/<timestamp>/temp/` directory. Its manifest
lists generated artifacts and their purposes. The final `export.mp4`,
Downloads copy, captions, reusable source assets and small sanitized
`summary.json` remain. Browser profiles and required authentication state
are never cleanup targets. Private run data and media stay ignored by Git.

After export, both final MP4s must be nonempty, have a video stream, fully
decode, and match expected dimensions and duration. Only then does automatic
cleanup move that run's raw footage, generated screenshots, caption frames,
encoded segments, temporary audio, renderer binary and verbose logs/reports
to macOS Trash. Unneeded successful-run context and validation reports are
also discarded. Anything required by another active or resumable run stays.
Trash is never emptied. `--finalize-run` is no longer required.

On failure, regenerable cards, captions and encoded segments are discarded.
Raw footage, checkpoint screenshots, original sanitized errors, capture logs,
and fixture/resume metadata remain for diagnosis or an explicit resume.
The terminal prints an exact `--cleanup-run` command. Run it only when that
evidence is no longer needed: it trashes explicitly owned failed-run media,
reports and private context, while preserving fixtures, profiles, captions,
summary, source files, final videos and other runs' dependencies.
`--cleanup-run <run> --dry-run` previews that targeted discard.

From the project root:

```sh
bash demo-video/start.sh
bash demo-video/start.sh --cleanup --dry-run
bash demo-video/start.sh --cleanup
bash demo-video/start.sh --keep-intermediates
bash demo-video/start.sh --cleanup-run /absolute/path/to/.local/TIMESTAMP --dry-run
```

`--keep-intermediates` disables automatic cleanup and ordinary cleanup for
that debug run. Explicit `--cleanup-run` can discard its failed evidence.
Legacy raw footage from before this policy remains protected; the optional
legacy `--finalize-run <run>` command still validates its final before Trash.
Ordinary cleanup preserves the latest failed run and uncertain older runs.

Cleanup rejects unknown files, symlinks, hard links, source files, final
videos, active outputs and saved dependencies. References and active file
usage are checked again before each move. Missing or ambiguous configuration
causes cleanup to skip and report its reason. No authentication, Drive
mutation, profile reset or OAuth change occurs during cleanup.
