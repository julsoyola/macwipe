"""Bounded native commands; process arguments are never collected."""
from __future__ import annotations

import ctypes
import os
import platform
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


MAX_OUTPUT_BYTES = 65536


def command_environment():
    """Fresh environment shared by bounded and cancellable native commands."""
    return dict(os.environ, HOMEBREW_NO_ANALYTICS="1",
                HOMEBREW_NO_AUTO_UPDATE="1", HOMEBREW_NO_ENV_HINTS="1",
                LC_ALL="C")


@dataclass
class CommandResult:
    ok: bool
    output: str = ""
    problem: str = ""
    code: int | None = None


class System:
    def __init__(self, home=None):
        self.home = Path(home or Path.home()).absolute()
        self.macos = platform.system() == "Darwin"
        self._proc_library = None
        self._proc_pidpath = None

    def application_roots(self):
        return [("system_applications", Path("/Applications")),
                ("user_applications", self.home / "Applications")]

    def launch_roots(self):
        return (self.home / "Library/LaunchAgents", Path("/Library/LaunchAgents"),
                Path("/Library/LaunchDaemons"))

    def tool(self, name):
        found = shutil.which(name)
        return str(Path(found).resolve()) if found else None

    def run(self, argv, timeout=15):
        executable = self.tool(argv[0])
        if not executable:
            return CommandResult(False, problem=f"Missing tool: {argv[0]}")
        # Disable Homebrew telemetry and updates, including during dry-run.
        env = command_environment()
        try:
            with tempfile.TemporaryFile() as output:
                result = subprocess.run([executable, *argv[1:]], env=env,
                                        stdin=subprocess.DEVNULL, stdout=output,
                                        stderr=output, timeout=timeout, check=False)
                output.seek(0)
                data = output.read(MAX_OUTPUT_BYTES + 1)
            if len(data) > MAX_OUTPUT_BYTES:
                return CommandResult(False, problem="Output exceeded 64 KiB; incomplete check")
            text = data.decode("utf-8", errors="replace")
            if result.returncode:
                # Raw errors may contain secrets or process arguments.
                return CommandResult(False, text, f"{argv[0]} exited {result.returncode}; unavailable or denied", result.returncode)
            return CommandResult(True, text, code=0)
        except subprocess.TimeoutExpired:
            return CommandResult(False, problem=f"{argv[0]} timed out; incomplete check")
        except OSError as error:
            return CommandResult(False, problem=f"{argv[0]} unavailable ({type(error).__name__})")

    def executable(self, pid):
        if not self.macos:
            return None
        try:
            if self._proc_pidpath is None:
                library = ctypes.CDLL("/usr/lib/libproc.dylib")
                function = library.proc_pidpath
                function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
                function.restype = ctypes.c_int
                self._proc_library = library
                self._proc_pidpath = function
            # Cache the FFI binding, never process identities: every PID stays fresh.
            function = self._proc_pidpath
            buffer = ctypes.create_string_buffer(4096)
            if function(pid, buffer, len(buffer)) <= 0:
                return None
            path = Path(os.fsdecode(buffer.value))
            return str(path.resolve(strict=True)) if path.is_absolute() else None
        except (OSError, ValueError):
            return None

    def processes(self):
        result = self.run(["ps", "-U", str(os.getuid()), "-o", "pid=,pcpu=,pmem="])
        processes, problems = [], []
        if not result.ok:
            return processes, [result.problem]
        lines = result.output.splitlines()
        if len(lines) > 1024:
            problems.append("Process list limited to 1024 entries")
        for line in lines[:1024]:
            try:
                pid, cpu, memory = line.split()
                pid = int(pid)
                if pid == os.getpid():
                    continue
                path = self.executable(pid)
                if not path:
                    problems.append(f"Executable identity unavailable for PID {pid}; process may have exited")
                processes.append({"pid": pid, "cpu_percent": float(cpu),
                                  "memory_percent": float(memory), "executable": path})
            except ValueError:
                problems.append("Unrecognized process row")
        return processes, problems

    def capacity(self):
        usage = shutil.disk_usage(self.home)
        return {"total_bytes": usage.total, "used_bytes": usage.used,
                "free_bytes": usage.free}
