"""Helper-owned cancellable native command groups; the CLI remains unchanged."""
from __future__ import annotations

import os
import signal
import subprocess
import tempfile
import threading
import time

from .system import MAX_OUTPUT_BYTES, CommandResult, System, command_environment


class ManagedSystem(System):
    def __init__(self, home=None):
        super().__init__(home)
        self.cancel = threading.Event()
        self.lock = threading.Lock()
        self.children = set()

    @staticmethod
    def terminate(child):
        # start_new_session owns this process group. Never kill unrelated processes.
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        # Descendants can outlive a terminated parent.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=2)

    def stop(self):
        self.cancel.set()
        with self.lock:
            children = list(self.children)
        for child in children:
            try:
                self.terminate(child)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def run(self, argv, timeout=15):
        if self.cancel.is_set():
            return CommandResult(False, problem="Session operation cancelled")
        tool = self.tool(argv[0])
        if not tool:
            return CommandResult(False, problem=f"Missing tool: {argv[0]}")
        env = command_environment()
        child = None
        try:
            with tempfile.TemporaryFile() as output:
                with self.lock:
                    if self.cancel.is_set():
                        return CommandResult(False, problem="Session operation cancelled")
                    child = subprocess.Popen([tool, *argv[1:]], env=env,
                        stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                        start_new_session=True)
                    self.children.add(child)
                deadline = time.monotonic() + timeout
                while child.poll() is None:
                    problem = ("Session operation cancelled" if self.cancel.is_set() else
                               "Native command timed out" if time.monotonic() >= deadline else
                               "Native output exceeded 64 KiB" if os.fstat(output.fileno()).st_size > MAX_OUTPUT_BYTES else None)
                    if problem:
                        self.terminate(child)
                        return CommandResult(False, problem=problem)
                    try:
                        child.wait(timeout=.1)
                    except subprocess.TimeoutExpired:
                        continue
                output.seek(0)
                data = output.read(MAX_OUTPUT_BYTES + 1)
            if len(data) > MAX_OUTPUT_BYTES:
                return CommandResult(False, problem="Native output exceeded 64 KiB")
            text = data.decode("utf-8", errors="replace")
            return CommandResult(child.returncode == 0, text,
                "" if child.returncode == 0 else f"{argv[0]} unavailable or denied (exit {child.returncode})",
                child.returncode)
        except OSError as error:
            return CommandResult(False, problem=f"Native command unavailable ({type(error).__name__})")
        finally:
            if child:
                with self.lock:
                    self.children.discard(child)
