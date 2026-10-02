"""Broad inventory. Diagnostics never invoke cleanup."""
from __future__ import annotations

import os
import platform
import plistlib
from pathlib import Path

from .paths import Cancelled, Walker
from .rules import detect

SECTIONS = ("Storage", "Caches", "Applications", "Startup", "Performance", "Privacy")
PRIVACY = [
    "Manually review System Settings > Privacy & Security permissions.",
    "Review browser extensions in each browser's own extension settings.",
    "Inventory cannot identify spyware or certify that a Mac is clean.",
    "In System Settings > General > Login Items, turn off launch-at-login independently of uninstalling.",
    "For apps with services, use the vendor's documented uninstaller; bundle removal is not complete uninstallation.",
]


def launch_inventory(root):
    records, problems = [], []
    root = Path(root)
    if any(p.is_symlink() for p in [root, *root.parents]):
        return records, ["Launch-service root is a symlink; skipped"]
    if not root.exists():
        return records, []
    try:
        with os.scandir(root) as entries:
            for index, entry in enumerate(entries):
                if index >= 250:
                    problems.append("Launch-service listing limited to 250 entries")
                    break
                path = Path(entry.path)
                if path.suffix != ".plist" or path.is_symlink():
                    continue
                try:
                    if not path.is_file() or path.stat().st_size > 1048576:
                        problems.append("Non-file or oversized service plist skipped")
                        continue
                    with path.open("rb") as stream:
                        info = plistlib.load(stream)
                    label = info.get("Label")
                    if not isinstance(label, str) or label.startswith("com.apple."):
                        continue
                    records.append({"path": str(path), "label": label,
                                    "identity_verified": False,
                                    "action": "Manual review only; never execute plist programs"})
                except (OSError, ValueError, plistlib.InvalidFileException):
                    problems.append("Unreadable or invalid service plist")
    except OSError:
        problems.append("Service directory denied or unavailable")
    return records, sorted(set(problems))


def scan(system, section="all", network=False, max_entries=20000,
         cancelled=None, on_progress=None):
    cancelled = cancelled or (lambda: False)
    def progress(name):
        if cancelled():
            raise Cancelled("Scan cancelled")
        if on_progress:
            on_progress(name)
    walker = Walker(max_entries=max_entries, cancelled=cancelled)
    report = {"schema_version": 1, "read_only": True,
              "system": {"os": platform.system(), "macos_version": platform.mac_ver()[0],
                         "architecture": platform.machine()},
              "sections": {}, "candidates": [], "limitations": []}
    if not system.macos:
        report["limitations"].append("macOS-only diagnostics and execution are unsupported on this OS")
        return report, walker
    requested = set(SECTIONS) if section == "all" else {section}
    inventory = {}
    roots = {"Storage": [("downloads", system.home / "Downloads"),
                         ("application_support", system.home / "Library/Application Support")],
             "Caches": [("user_caches", system.home / "Library/Caches")],
             "Applications": system.application_roots()}
    for category, directories in roots.items():
        if category not in requested:
            continue
        progress(category)
        data = {}
        for name, path in directories:
            items, problems = walker.children(path)
            data[name] = {"items": items, "problems": problems}
            inventory[name] = items
        report["sections"][category] = data
    if "Storage" in requested:
        try:
            report["sections"]["Storage"]["disk"] = system.capacity()
        except OSError:
            report["limitations"].append("Disk capacity unavailable")
    if "Caches" in requested or "Storage" in requested:
        candidates, problems = detect(system, walker, inventory.get("downloads", []))
        # Section scans expose only that section's candidates.
        report["candidates"] = [c for c in candidates
            if (c["rule_id"] == "download-trash" and "Storage" in requested)
            or (c["rule_id"] != "download-trash" and "Caches" in requested)]
        report["limitations"].extend(problems)
    if "Applications" in requested:
        report["sections"]["Applications"]["guidance"] = [
            "Applications are inventory only in v1. Review vendor uninstall instructions.",
            "Unknown, Apple, security, and management apps are never removed automatically.",
            "Move a reviewed ordinary app to Trash manually; do not empty Trash automatically."]
    if "Startup" in requested:
        progress("Startup")
        services, problems = [], []
        for root in system.launch_roots():
            items, issues = launch_inventory(root)
            services.extend(items)
            problems.extend(issues)
        background = system.run(["sfltool", "dumpbtm"])
        disabled = system.run(["launchctl", "print-disabled", f"gui/{os.getuid()}"])
        mdm = system.run(["profiles", "status", "-type", "enrollment"])
        extensions = system.run(["systemextensionsctl", "list"])
        report["sections"]["Startup"] = {
            "third_party_services": services, "problems": problems,
            "background_items": {"supported": background.ok,
                "record_count": background.output.count("UUID:") if background.ok else None,
                "problem": background.problem,
                "guidance": "Review Login Items in System Settings; count is format-dependent"},
            "disabled_services": {"supported": disabled.ok, "problem": disabled.problem,
                "guidance": "Review current launchctl print-disabled output manually"},
            "mdm": {"supported": mdm.ok, "problem": mdm.problem,
                "status": mdm.output.strip().splitlines() if mdm.ok else []},
            "system_extensions": {"supported": extensions.ok, "problem": extensions.problem,
                "status": extensions.output.strip().splitlines() if extensions.ok else []},
            "guidance": "Startup changes are manual in v1; no services are disabled or removed"}
    if "Performance" in requested:
        progress("Performance")
        processes, problems = system.processes()
        memory = system.run(["memory_pressure", "-Q"])
        swap = system.run(["sysctl", "vm.swapusage"])
        report["sections"]["Performance"] = {
            "memory_pressure": {"status": memory.output.strip().splitlines()[-4:] if memory.ok else [],
                                "problem": memory.problem},
            "swap": {"status": swap.output.strip(), "problem": swap.problem},
            "top_cpu": sorted(processes, key=lambda p: p["cpu_percent"], reverse=True)[:10],
            "top_memory": sorted(processes, key=lambda p: p["memory_percent"], reverse=True)[:10],
            "problems": problems, "guidance": "Instantaneous current-user sample, not a speed prediction"}
    if "Privacy" in requested:
        progress("Privacy")
        report["sections"]["Privacy"] = {"guidance": PRIVACY}
    if network:
        network_result = system.run(["scutil", "--nwi"])
        report["network"] = {"supported": network_result.ok,
            "problem": network_result.problem,
            "guidance": "Local network-state check only: no packets sent, no DNS/speed/security test",
            "active_interfaces_reported": network_result.output.count("flags") if network_result.ok else None}
    progress("Complete")
    return report, walker
