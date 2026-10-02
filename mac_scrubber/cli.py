"""Read-only defaults; selection never implies execution."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .actions import create_plan, execute
from .scan import SECTIONS, scan
from .system import System


def emit(value, json_mode=False):
    # JSON escaping also prevents filenames/tool output injecting terminal controls.
    if json_mode or "sections" not in value:
        print(json.dumps(value, indent=2, ensure_ascii=True))
        return
    print("Read-only inventory (sizes are estimates, not speed predictions)")
    print(json.dumps(value["system"], ensure_ascii=True))
    for section, data in value["sections"].items():
        print(f"\n{section}")
        for name, detail in data.items():
            if isinstance(detail, dict) and "items" in detail:
                items = detail["items"]
                print(f"  {name}: {len(items)} inventoried; largest 10 shown")
                for item in items[:10]:
                    marker = "" if item["complete"] else " (incomplete lower bound)"
                    print(f"    {item['bytes']} bytes {json.dumps(item['path'])}{marker}")
                print("  Issues: " + json.dumps(detail["problems"]))
            else:
                print(f"  {name}: " + json.dumps(detail, ensure_ascii=True))
    candidates = value["candidates"]
    print(f"\nReview candidates: {len(candidates)} (first 25 shown; --json shows all)")
    for candidate in candidates[:25]:
        print(json.dumps(candidate, ensure_ascii=True))
    for problem in value["limitations"]:
        print("Incomplete: " + json.dumps(problem))
    if "network" in value:
        print("Network: " + json.dumps(value["network"]))


def write_report(path, value):
    path = Path(path)
    # No overwrite, private permissions, and no leaf symlink following.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True)
        stream.write("\n")


def confirmation(plan, input_fn=input):
    try:
        return input_fn(f'Type {plan.confirmation!r} to execute, or Enter to cancel: ') == plan.confirmation
    except (EOFError, KeyboardInterrupt):
        return False


def interactive(system, dry_run=False, input_fn=input):
    cached = {}
    while True:
        print("\nStorage | Caches | Applications | Startup | Performance | Privacy")
        print("Choose a section, 'all' (diagnostics only), 'refresh', or 'quit'.")
        try:
            choice = input_fn("> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return 0
        if choice in ("quit", "q", "exit"):
            return 0
        if choice == "refresh":
            cached.clear()
            continue
        section = next((s for s in SECTIONS if s.lower() == choice), None)
        if choice != "all" and not section:
            print("Unknown section.")
            continue
        key = section or "all"
        if key not in cached:
            cached[key] = scan(system, key)
        report, walker = cached[key]
        emit(report)
        if key == "all" or not report["candidates"]:
            continue
        try:
            selection = input_fn("Candidate IDs separated by commas, or Enter to return: ").strip()
            if not selection:
                continue
            plan = create_plan(report, [s.strip() for s in selection.split(",")], system, walker)
            emit(plan.report())
            if dry_run:
                emit(execute(plan, system, dry_run=True))
            elif confirmation(plan, input_fn):
                result = execute(plan, system, confirmed=True)
                emit(result)
                cached.clear()
            else:
                print("Cancelled; nothing changed.")
        except (OSError, ValueError, PermissionError) as error:
            print(f"Plan/action stopped: {json.dumps(str(error))}")
        except (EOFError, KeyboardInterrupt):
            return 0


def parser():
    result = argparse.ArgumentParser(description="Bounded macOS inventory; read-only by default")
    result.add_argument("mode", nargs="?", choices=("scan", "interactive", "plan", "apply"), default="scan")
    result.add_argument("--section", choices=("all", *SECTIONS), default="all")
    result.add_argument("--select", nargs="+", metavar="ID", help="Explicit candidate IDs from a fresh scan; never all")
    result.add_argument("--dry-run", action="store_true", help="Review and simulate without mutation")
    result.add_argument("--json", action="store_true", help="JSON on stdout; execution still requires interactive confirmation")
    result.add_argument("--report", metavar="PATH", help="Create a private JSON report; refuses overwrite")
    result.add_argument("--network", action="store_true", help="Include local network-state diagnostics only")
    result.add_argument("--max-entries", type=int, default=20000, help="Global inventory budget (1–20000)")
    return result


def main(argv=None, system=None, input_fn=input):
    args = parser().parse_args(argv)
    system = system or System()
    if not 1 <= args.max_entries <= 20000:
        parser().error("--max-entries must be between 1 and 20000")
    if args.mode == "interactive":
        if args.json or args.report or args.select or args.network or args.section != "all":
            parser().error("interactive supports --dry-run only; use scan for report/options")
        if args.max_entries != 20000:
            parser().error("interactive uses the default budget; use scan for --max-entries")
        return interactive(system, args.dry_run, input_fn)
    if args.mode in ("scan",) and args.select:
        parser().error("scan never creates actions; use plan or apply with --select")
    try:
        report, walker = scan(system, args.section, args.network, args.max_entries)
        status = 0
        if args.mode in ("plan", "apply"):
            if not args.select:
                parser().error("plan/apply require explicit --select IDs")
            plan = create_plan(report, args.select, system, walker)
            report = plan.report()
            if args.mode == "apply" or args.dry_run:
                if not args.dry_run:
                    if args.json or not sys.stdin.isatty():
                        raise PermissionError("Real execution requires an interactive terminal; no --yes bypass")
                    emit(report)
                    if not confirmation(plan, input_fn):
                        print("Cancelled; nothing changed.")
                        return 0
                report["execution"] = execute(plan, system, confirmed=not args.dry_run, dry_run=args.dry_run)
                if any(item["status"] in ("failed", "partial-failure") for item in report["execution"]["results"]):
                    status = 1
        if args.report:
            write_report(args.report, report)
        emit(report, args.json)
        return status
    except (OSError, ValueError, PermissionError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(json.dumps({"error": "Interrupted; an action may have partially completed. Inspect targets before retrying."}), file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
