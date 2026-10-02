"""Plan, explicit confirmation, execution, and separate verification."""
from __future__ import annotations

import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from .paths import UnsafePath, Walker, fingerprint, validate
from .rules import closed_paths, registry, running_matches


@dataclass(frozen=True)
class Action:
    id: str
    rule_id: str
    path: str | None
    estimated_bytes: int | None
    evidence: str
    consequences: str
    reversibility: str
    closed_checks: tuple
    manifest: tuple = ()
    command: tuple = ()
    preview: str = ""
    tool_identity: tuple = ()


@dataclass(frozen=True)
class Plan:
    actions: tuple

    @property
    def confirmation(self):
        return f"CLEAN {len(self.actions)}"

    def report(self):
        # File identities are revalidation internals, not persisted history.
        result = []
        for action in self.actions:
            item = asdict(action)
            item.pop("manifest")
            item.pop("tool_identity")
            result.append(item)
        return {"actions": result, "confirmation_required": self.confirmation,
                "note": "Trash does not reclaim space until you independently empty it"}


def check_candidate(candidate, system):
    rule_id = candidate["rule_id"]
    if rule_id == "download-trash":
        path = validate(Path(candidate["path"]), system.home)
        if path.parent != system.home / "Downloads" or not path.is_file():
            raise UnsafePath("Only individual top-level regular download files are eligible")
        return path
    rule = registry().get(rule_id)
    if not rule:
        raise UnsafePath("Unknown rule")
    if rule.command:
        if candidate.get("path") is not None:
            raise UnsafePath("Command candidate cannot carry a path")
        return None
    path = validate(Path(candidate["path"]), system.home)
    if path != system.home / rule.relative_path or not path.is_dir():
        raise UnsafePath("Path does not match the reviewed rule")
    return path


def create_plan(report, selected_ids, system, walker):
    if not selected_ids or len(selected_ids) != len(set(selected_ids)):
        raise ValueError("Select one or more unique candidate IDs; there is no select-all action")
    available = {c["id"]: c for c in report["candidates"]}
    actions = []
    for candidate_id in selected_ids:
        if candidate_id not in available:
            raise ValueError(f"Unknown candidate ID: {candidate_id}")
        candidate = available[candidate_id]
        path = check_candidate(candidate, system)
        manifest, command, preview, identity = (), (), "", ()
        if path:
            measured = walker.measure(path)
            if not measured["complete"]:
                raise UnsafePath("Incomplete or unsafe candidate tree; rescan after manual review")
            manifest = tuple(sorted(measured["manifest"].items()))
        else:
            command = registry()[candidate["rule_id"]].command
            tool = system.tool(command[0])
            if not tool:
                raise ValueError("Cleanup tool is missing")
            identity = (tool, fingerprint(Path(tool)))
            result = system.run([*command, "--dry-run"], timeout=30)
            if not result.ok:
                raise ValueError(result.problem)
            preview = result.output
        actions.append(Action(candidate_id, candidate["rule_id"], str(path) if path else None,
                              candidate["estimated_bytes"], candidate["evidence"],
                              candidate["consequences"], candidate["reversibility"],
                              tuple(candidate["closed_checks"]), manifest, command, preview, identity))
    return Plan(tuple(actions))


def revalidate(action, system, cancelled=None):
    path = check_candidate({"rule_id": action.rule_id, "path": action.path}, system)
    if path:
        # Repeated traversal here is intentional: fresh identity check before mutation.
        walker = Walker(max_entries=20000, seconds=20, cancelled=cancelled)
        current = walker.measure(path)
        if not current["complete"] or tuple(sorted(current["manifest"].items())) != action.manifest:
            raise UnsafePath("Candidate changed since review, or became incomplete; rescan")
    else:
        if action.command != registry()[action.rule_id].command:
            raise UnsafePath("Command does not match the reviewed registry rule")
        executable, identity = action.tool_identity
        if system.tool(action.command[0]) != executable or fingerprint(Path(executable)) != identity:
            raise UnsafePath("Cleanup executable changed since review")
    return path


def move_to_trash(path, system):
    trash = system.home / ".Trash"
    if any(p.is_symlink() for p in [trash, *trash.parents]):
        raise UnsafePath("Trash or an ancestor is a symlink")
    if trash.exists():
        info = trash.lstat()
        if not trash.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise UnsafePath("Trash is not a private user-owned directory")
    else:
        trash.mkdir(mode=0o700)
    # Exclusive private destination, no overwrite and no cross-volume copy fallback.
    container = Path(tempfile.mkdtemp(prefix="mac-scrubber-", dir=trash))
    destination = container / path.name
    original = fingerprint(path)
    try:
        os.rename(path, destination)
    except OSError:
        container.rmdir()
        raise
    if path.exists() or path.is_symlink() or fingerprint(destination) != original:
        raise UnsafePath(f"Trash move verification incomplete; inspect {container}")
    return str(destination)


def execute(plan, system, confirmed=False, dry_run=False, cancelled=None):
    if not system.macos:
        raise ValueError("Cleanup requires macOS")
    if not dry_run and confirmed is not True:
        raise PermissionError("Explicit confirmation is required")
    try:
        before = system.capacity()["free_bytes"]
    except OSError:
        before = None
    cancelled = cancelled or (lambda: False)
    results = []
    for action in plan.actions:
        try:
            if cancelled():
                results.append({"id": action.id, "status": "skipped", "mutated": False,
                                "problem": "Session stopped before this action"})
                continue
            if dry_run:
                results.append({"id": action.id, "status": "dry-run", "mutated": False})
                continue
            path = revalidate(action, system, cancelled)
            rule = registry().get(action.rule_id)
            if rule and rule.closed_executable_names:
                processes, problems = system.processes()
                if problems:
                    raise UnsafePath("Cannot verify closed-app checks; process inventory is incomplete")
                busy = running_matches(processes, closed_paths(rule, system, processes))
                if busy:
                    raise UnsafePath("Required executable is running; close it and retry")
            if action.rule_id == "download-trash":
                opened = system.run(["lsof", "-n", "-P", "-F", "p", "--", str(path)])
                if opened.ok and opened.output.strip():
                    raise UnsafePath("Download is open in a process; close it before moving")
                if not opened.ok and not (opened.code == 1 and not opened.output.strip()):
                    raise UnsafePath("Cannot verify whether the download is open")
            # Recheck after process checks and immediately before action.
            path = revalidate(action, system, cancelled)
            if path:
                destination = move_to_trash(path, system)
                results.append({"id": action.id, "status": "verified", "mutated": True,
                                "trash_path": destination, "reversible": True})
            else:
                preview = system.run([*action.command, "--dry-run"], timeout=30)
                if not preview.ok or preview.output != action.preview:
                    raise UnsafePath("Package-manager preview changed or failed; create a new plan")
                result = system.run(list(action.command), timeout=120)
                verification = system.run([*action.command, "--dry-run"], timeout=30)
                verified = (result.ok and verification.ok
                            and not any(line.lstrip().startswith("Would remove")
                                        for line in verification.output.splitlines()))
                results.append({"id": action.id, "status": "verified" if verified else "partial-failure",
                                "mutated": True, "reversible": False,
                                "problem": "" if verified else "Command or post-cleanup preview failed; review manually"})
        except (OSError, ValueError) as error:
            results.append({"id": action.id, "status": "failed", "mutated": None,
                            "problem": str(error) if isinstance(error, UnsafePath) else type(error).__name__})
    try:
        after = system.capacity()["free_bytes"]
    except OSError:
        after = None
    return {"dry_run": dry_run, "results": results,
            "free_bytes_before": before, "free_bytes_after": after,
            "free_bytes_change": after - before if before is not None and after is not None else None,
            "note": "Concurrent activity affects free space; Trash still occupies disk. No speed improvement promised."}
