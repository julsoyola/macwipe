"""Non-destructive coverage for shared command setup and the helper scaffold."""

import ctypes
import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from mac_scrubber.helper import LocalServer, Session
from mac_scrubber.managed import ManagedSystem
from mac_scrubber.system import MAX_OUTPUT_BYTES, System, command_environment


class RuntimeTests(unittest.TestCase):
    def test_command_environment_is_private_and_shared(self):
        with patch.dict(os.environ, {"HOMEBREW_NO_ANALYTICS": "0"}):
            first = command_environment()
            first["HOMEBREW_NO_ANALYTICS"] = "changed"
            second = command_environment()
            self.assertEqual(second["HOMEBREW_NO_ANALYTICS"], "1")
            self.assertEqual(second["HOMEBREW_NO_AUTO_UPDATE"], "1")
            self.assertEqual(second["HOMEBREW_NO_ENV_HINTS"], "1")
            self.assertEqual(second["LC_ALL"], "C")
            self.assertEqual(os.environ["HOMEBREW_NO_ANALYTICS"], "0")

    def test_process_binding_reused_but_identity_is_always_fresh(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory, "first").resolve()
            second = Path(directory, "second").resolve()
            first.touch()
            second.touch()
            paths = iter([first, second])

            def query(pid, buffer, size):
                buffer.value = os.fsencode(next(paths))
                return len(buffer.value)

            function = Mock(side_effect=query)
            library = Mock(proc_pidpath=function)
            system = System(directory)
            system.macos = True
            with patch("mac_scrubber.system.ctypes.CDLL", return_value=library) as load:
                self.assertEqual(system.executable(123), str(first))
                self.assertEqual(system.executable(123), str(second))
            load.assert_called_once_with("/usr/lib/libproc.dylib")
            self.assertEqual(function.call_count, 2)
            self.assertEqual(function.argtypes, [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32])

    def test_process_binding_failure_can_be_retried(self):
        system = System()
        system.macos = True
        library = Mock(proc_pidpath=Mock(return_value=0))
        with patch("mac_scrubber.system.ctypes.CDLL", side_effect=[OSError, library]) as load:
            self.assertIsNone(system.executable(123))
            self.assertIsNone(system.executable(123))
        self.assertEqual(load.call_count, 2)

    def test_managed_command_keeps_argument_and_environment_contract(self):
        system = ManagedSystem()
        child = Mock(returncode=0)
        child.poll.return_value = 0

        def launch(argv, **kwargs):
            kwargs["stdout"].write(b"fixture output")
            return child

        with patch.object(system, "tool", return_value="/fixture/tool"), \
                patch("mac_scrubber.managed.subprocess.Popen", side_effect=launch) as popen:
            result = system.run(["tool", "--dry-run"])
        self.assertTrue(result.ok)
        self.assertEqual(result.output, "fixture output")
        self.assertEqual(popen.call_args.args[0], ["/fixture/tool", "--dry-run"])
        self.assertEqual(popen.call_args.kwargs["env"], command_environment())
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertFalse(system.children)

    def test_managed_output_cap_and_cancellation_stay_bounded(self):
        system = ManagedSystem()
        child = Mock(returncode=0)
        child.poll.return_value = None

        def launch(argv, **kwargs):
            kwargs["stdout"].write(b"x" * (MAX_OUTPUT_BYTES + 1))
            kwargs["stdout"].flush()
            return child

        with patch.object(system, "tool", return_value="/fixture/tool"), \
                patch("mac_scrubber.managed.subprocess.Popen", side_effect=launch), \
                patch.object(system, "terminate") as terminate:
            result = system.run(["tool"])
        self.assertFalse(result.ok)
        self.assertIn("exceeded", result.problem)
        terminate.assert_called_once_with(child)
        self.assertFalse(system.children)
        system.cancel.set()
        with patch("mac_scrubber.managed.subprocess.Popen") as popen:
            self.assertFalse(system.run(["tool"]).ok)
        popen.assert_not_called()

    def test_helper_missing_assets_fail_cleanly_without_exposing_api(self):
        # Stub the artifact to avoid scanning processes or checking the real Mac.
        artifact = Mock()
        artifact.describe.return_value = {"available": False}
        session = Session(system=Mock(), artifact=artifact)
        server = LocalServer(session)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path, authenticated=False):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1])
            headers = {"X-Macwipe-Token": session.token} if authenticated else {}
            try:
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()

        try:
            with tempfile.TemporaryDirectory() as directory, \
                    patch("mac_scrubber.helper.ASSETS", Path(directory)):
                status, body = request("/")
                self.assertEqual(status, 404)
                self.assertIn("not installed", json.loads(body)["error"])
                Path(directory, "dashboard.html").write_text("<h1>fixture</h1>")
                self.assertEqual(request("/")[0], 200)
                self.assertEqual(request("/../system.py")[0], 404)
                self.assertEqual(request("/api/status")[0], 401)
                status, body = request("/api/status", authenticated=True)
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)["state"], "idle")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
