#!/usr/bin/env python3
"""Compile the private Swift scanner with fixtures; optionally test WKWebView."""
import pathlib
import platform
import shutil
import subprocess
import sys
import tempfile

repo = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="macwipe-native-tests-") as directory:
    root = pathlib.Path(directory)
    source = (repo / "native/ViewController.swift").read_text()
    # The UI test uses only fixture roots and a no-op Trash operation.
    assert source.count("private let worker = FileWorker()") == 1, "Fixture injection must match exactly once"
    source = source.replace(
        "private let worker = FileWorker()",
        "private let worker = FileWorker(home: nativeTestHome, "
        "systemRoot: nativeTestSystem, trashItem: { _ in })",
    )
    (root / "main.swift").write_text(source + "\n" + (repo / "tests/native-scanner.swift").read_text())
    subprocess.run([
        "swiftc", "-target", platform.machine() + "-apple-macosx13.0",
        "-framework", "Cocoa", "-framework", "WebKit",
        str(root / "main.swift"), "-o", str(root / "check"),
    ], check=True, timeout=60)
    if "--ui" in sys.argv:
        # Use the generated bundle resources, including the injected bridge.
        assets = repo / "native/build/macwipe.app/Contents/Resources/Web"
        shutil.copytree(assets, root / "Web")
    subprocess.run([str(root / "check"), *sys.argv[1:]], cwd=root, check=True, timeout=60)
