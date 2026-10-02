"""Self-removal of a verified packaged artifact only; never the source tree."""
from __future__ import annotations

import json
import os
import plistlib
import sys
from pathlib import Path

from .actions import move_to_trash
from .paths import UnsafePath, fingerprint

IDENTIFIER = "io.macwipe.helper"


class Artifact:
    def __init__(self, path=None, build_id=None, packaged=False):
        self.path = Path(path) if path else None
        self.build_id = build_id
        self.packaged = packaged
        self.identity = fingerprint(self.path)[:3] if self.path and self.path.exists() else None

    @classmethod
    def current(cls):
        if not getattr(sys, "frozen", False):
            return cls()
        executable = Path(sys.executable).absolute()
        bundle = executable.parent.parent.parent
        marker = bundle / "Contents/Resources/macwipe-artifact.json"
        try:
            metadata = json.loads(marker.read_text())
            return cls(bundle, metadata["build_id"], True)
        except (OSError, ValueError, KeyError):
            return cls(bundle, packaged=True)

    def check_identity(self):
        path = self.path
        if not self.packaged or not path or not self.build_id:
            raise UnsafePath("Self-removal is disabled in source/development mode")
        if path.suffix != ".app" or fingerprint(path)[:3] != self.identity:
            raise UnsafePath("Helper artifact identity changed")
        if any(p.is_symlink() for p in [path, *path.parents]):
            raise UnsafePath("Helper artifact or ancestor is a symlink")
        plist_path = path / "Contents/Info.plist"
        marker_path = path / "Contents/Resources/macwipe-artifact.json"
        if any(p.is_symlink() for p in [plist_path, marker_path, *marker_path.parents]):
            raise UnsafePath("Helper metadata is linked")
        with plist_path.open("rb") as stream:
            info = plistlib.load(stream)
        marker = json.loads(marker_path.read_text())
        if (info.get("CFBundleIdentifier") != IDENTIFIER or marker.get("build_id") != self.build_id
                or marker.get("identifier") != IDENTIFIER):
            raise UnsafePath("Packaged helper marker does not match")
        executable = path / "Contents/MacOS/macwipe"
        if not executable.is_file() or executable.is_symlink():
            raise UnsafePath("Packaged helper executable is missing or linked")
        allowed = marker.get("symlinks", {})
        actual = {}
        count = 0
        for root, dirs, files in os.walk(path, followlinks=False):
            for name in dirs + files:
                count += 1
                if count > 10000:
                    raise UnsafePath("Helper artifact validation budget exceeded")
                child = Path(root) / name
                if child.is_symlink():
                    target = os.readlink(child)
                    if Path(target).is_absolute() or not child.resolve().is_relative_to(path):
                        raise UnsafePath("Helper contains a link outside its bundle")
                    actual[str(child.relative_to(path))] = target
        if actual != allowed:
            raise UnsafePath("Helper bundle symlink layout changed")
        return path

    def eligible(self, system):
        path = self.check_identity()
        if not path.is_relative_to(system.home) or ".Trash" in path.relative_to(system.home).parts:
            raise UnsafePath("Self-removal requires a helper in your home, outside Trash; use Finder")
        if path.lstat().st_uid != os.getuid():
            raise UnsafePath("Helper is not owned by the current user; use Finder")
        processes, problems = system.processes()
        executable = str((path / "Contents/MacOS/macwipe").resolve())
        if problems:
            raise UnsafePath("Cannot verify other helper instances; use Finder after quitting")
        if any(p["pid"] != os.getpid() and p["executable"] == executable for p in processes):
            raise UnsafePath("Another session is using this helper; quit it first")
        return path

    def describe(self, system):
        try:
            self.eligible(system)
            return {"available": True, "path": str(self.path), "reason": "Only this packaged helper moves to Trash"}
        except (OSError, ValueError) as error:
            return {"available": False, "path": str(self.path) if self.path else None,
                    "reason": str(error), "can_reveal": bool(self.packaged and self.path)}

    def remove(self, system):
        path = self.eligible(system)
        return move_to_trash(path, system)
