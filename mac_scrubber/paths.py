"""No-follow path validation and bounded directory measurement."""
from __future__ import annotations

import os
import stat
import time
from pathlib import Path


class Cancelled(ValueError):
    """Cooperative cancellation; never yields an actionable partial scan."""


class UnsafePath(ValueError):
    pass


def fingerprint(path):
    info = path.lstat()
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_nlink)


def validate(path, home):
    path, home = Path(path), Path(home)
    if not path.is_absolute() or ".." in path.parts:
        raise UnsafePath("Expected an absolute path without parent traversal")
    # The supplied home itself must be canonical, not a symlink.
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise UnsafePath("Symlink in path or ancestor")
    if home.resolve() != home:
        raise UnsafePath("Home path is not canonical")
    if not path.is_relative_to(home) or path == home:
        raise UnsafePath("Outside the current user's home or protected home root")
    protected = [home / name for name in ("Library", "Library/Caches",
                 "Library/Application Support", "Library/Containers", "Downloads",
                 "Applications", ".Trash", ".npm")]
    if path in protected:
        raise UnsafePath("Protected parent directory")
    if path.lstat().st_uid != os.getuid():
        raise UnsafePath("Candidate is not owned by the current user")
    return path


class Walker:
    def __init__(self, max_entries=20000, seconds=20, cancelled=None):
        self.cancelled = cancelled or (lambda: False)
        self.remaining = max_entries
        self.deadline = time.monotonic() + seconds
        self.cache = {}
        self.allocated = {}

    def measure(self, path):
        if self.cancelled():
            raise Cancelled("Scan cancelled")
        path = Path(path)
        key = str(path)
        if key in self.cache:
            return self.cache[key]
        # Reuse a subtree already inventoried under a parent. Incomplete parent
        # scans conservatively make subtrees ineligible rather than traversing again.
        for parent, measured in list(self.cache.items()):
            if path.is_relative_to(Path(parent)):
                manifest = {name: stamp for name, stamp in measured["manifest"].items()
                            if Path(name).is_relative_to(path)}
                result = {"bytes": sum(self.allocated.get(name, 0) for name in manifest),
                          "complete": measured["complete"] and key in manifest,
                          "problems": measured["problems"], "manifest": manifest}
                self.cache[key] = result
                return result
        problems, manifest = [], {}
        total = 0
        stack = [path]
        while stack:
            if self.cancelled():
                raise Cancelled("Scan cancelled")
            current = stack.pop()
            if self.remaining <= 0 or time.monotonic() > self.deadline:
                problems.append("Entry/time budget exhausted; lower-bound size only")
                break
            self.remaining -= 1
            try:
                item = fingerprint(current)
                manifest[str(current)] = item
                mode = item[2]
                if stat.S_ISLNK(mode):
                    problems.append("Symlink skipped; never followed")
                elif stat.S_ISREG(mode):
                    allocated = current.lstat().st_blocks * 512
                    total += allocated
                    self.allocated[str(current)] = allocated
                    if item[5] > 1:
                        problems.append("Hard-linked file; size may be shared")
                elif stat.S_ISDIR(mode):
                    with os.scandir(current) as entries:
                        for entry in entries:
                            if len(stack) >= self.remaining:
                                problems.append("Directory entry budget exhausted")
                                break
                            stack.append(Path(entry.path))
                else:
                    problems.append("Special file skipped")
            except OSError as error:
                problems.append(f"Incomplete directory access ({type(error).__name__})")
        result = {"bytes": total, "complete": not problems,
                  "problems": sorted(set(problems)), "manifest": manifest}
        self.cache[key] = result
        return result

    def children(self, root):
        if self.cancelled():
            raise Cancelled("Scan cancelled")
        root = Path(root)
        # Scan roots are read-only, but no-follow applies there as well.
        if any(p.is_symlink() for p in [root, *root.parents]):
            return [], ["Inventory root has a symlink; skipped"]
        if not root.exists():
            return [], ["Directory not present"]
        try:
            with os.scandir(root) as entries:
                paths = []
                for entry in entries:
                    if len(paths) >= min(self.remaining, 1000):
                        break
                    paths.append(Path(entry.path))
            problems = [] if len(paths) < min(self.remaining, 1000) else ["Root listing capped; incomplete"]
            records = []
            for path in sorted(paths):
                measurement = self.measure(path)
                records.append({"path": str(path), "bytes": measurement["bytes"],
                                "complete": measurement["complete"],
                                "problems": measurement["problems"]})
            return sorted(records, key=lambda r: r["bytes"], reverse=True), problems
        except OSError as error:
            return [], [f"Root inaccessible ({type(error).__name__})"]
