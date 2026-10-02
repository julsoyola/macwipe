"""Reviewed rule registry. No implicit cache-name or arbitrary-command rules."""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .paths import UnsafePath, validate


@dataclass(frozen=True)
class Rule:
    id: str
    description: str
    relative_path: str
    evidence: str
    consequence: str
    closed_executable_names: tuple = ()
    command: tuple = ()


RULES = (
    Rule("pip-http", "pip HTTP response cache", "Library/Caches/pip/http-v2",
         "Exact documented pip HTTP cache location; not Python environments",
         "Cached packages must be downloaded again; environments stay intact.",
         ("Python", "python", "python3", *tuple(f"python3.{n}" for n in range(9, 16)))),
    Rule("pip-wheels", "pip built-wheel cache", "Library/Caches/pip/wheels",
         "Exact documented pip wheel cache location; not installed packages",
         "Locally built wheels may need rebuilding; environments stay intact.",
         ("Python", "python", "python3", *tuple(f"python3.{n}" for n in range(9, 16)))),
    Rule("brew-cleanup", "Homebrew default cleanup", "",
         "Homebrew owns detection and deletion; its current dry-run must be reviewed",
         "Permanently removes stale downloads and old installed versions; rollback may be lost.",
         ("ruby", "brew"), ("brew", "cleanup")),
)


def registry():
    result = {rule.id: rule for rule in RULES}
    if len(result) != len(RULES):
        raise ValueError("Duplicate cleanup rule ID")
    return result


def closed_paths(rule, system, processes):
    # proc_pidpath identities, never process command-line substring matches.
    paths = {str(Path(sys.executable).resolve())} if rule.id.startswith("pip-") else set()
    for name in rule.closed_executable_names:
        tool = system.tool(name)
        if tool:
            paths.add(tool)
    paths.update(p["executable"] for p in processes
                 if p["executable"] and Path(p["executable"]).name in rule.closed_executable_names)
    return paths


def running_matches(processes, expected_paths):
    return [p["pid"] for p in processes if p["pid"] != os.getpid()
            and p["executable"] in expected_paths]


def detect(system, walker, downloads):
    candidates, problems = [], []
    for rule in registry().values():
        if rule.command:
            if system.tool(rule.command[0]):
                candidates.append({"id": rule.id, "rule_id": rule.id, "path": None,
                    "estimated_bytes": None, "evidence": rule.evidence,
                    "consequences": rule.consequence, "reversibility": "Irreversible",
                    "closed_checks": list(rule.closed_executable_names), "command": list(rule.command)})
            continue
        path = system.home / rule.relative_path
        if not path.exists() and not path.is_symlink():
            continue
        try:
            validate(path, system.home)
            measured = walker.measure(path)
            if not path.is_dir() or not measured["complete"]:
                problems.append(f"{rule.id}: not eligible; incomplete or unsafe cache tree")
                continue
            candidates.append({"id": rule.id, "rule_id": rule.id, "path": str(path),
                "estimated_bytes": measured["bytes"], "evidence": rule.evidence,
                "consequences": rule.consequence, "reversibility": "Manual restore from Trash",
                "closed_checks": list(rule.closed_executable_names), "command": None})
        except (OSError, UnsafePath) as error:
            problems.append(f"{rule.id}: not eligible ({type(error).__name__})")
    for index, item in enumerate(downloads, 1):
        path = Path(item["path"])
        try:
            validate(path, system.home)
            if not path.is_file() or not item["complete"]:
                continue
            candidates.append({"id": f"download-{index}", "rule_id": "download-trash",
                "path": str(path), "estimated_bytes": item["bytes"],
                "evidence": "Individual top-level download; size is not proof it is disposable",
                "consequences": "May contain personal work. Review contents and close any application using it.",
                "reversibility": "Manual restore from Trash", "closed_checks": [], "command": None})
        except (OSError, UnsafePath):
            continue
    return candidates, problems
