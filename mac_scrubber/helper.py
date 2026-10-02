"""Authenticated loopback dashboard; one reviewed operation per session."""
from __future__ import annotations

import argparse
import hmac
import http.client
import json
import mimetypes
import os
import secrets
import signal
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .actions import create_plan, execute
from .artifact import Artifact
from .cli import write_report
from .managed import ManagedSystem
from .paths import Cancelled
from .scan import scan

ASSETS = Path(__file__).parent / "ui"


class Conflict(ValueError):
    pass


class Session:
    def __init__(self, system=None, artifact=None, dry_run=False):
        self.system = system or ManagedSystem()
        self.artifact = artifact or Artifact.current()
        self.dry_run = dry_run
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.cancel_event = threading.Event()
        self.worker = None
        self.busy = None
        self.state = "idle"
        self.phase = "Ready to scan"
        self.report = None
        self.walker = None
        self.plan = None
        self.plan_id = None
        self.results = None
        self.removal_id = None
        self.removal_identity = None
        self.removal = self.artifact.describe(self.system)
        self.server = None

    def status(self):
        with self.lock:
            return {"state": self.state, "phase": self.phase, "busy": self.busy,
                    "scan_ready": self.report is not None, "dry_run": self.dry_run,
                    "plan_id": self.plan_id, "plan": self.plan.report() if self.plan else None,
                    "results": self.results, "helper": self.removal}

    def cancelled(self):
        return self.cancel_event.is_set() or self.stop_event.is_set()

    def progress(self, phase):
        with self.lock:
            self.phase = phase

    def launch(self, kind, operation):
        # Caller holds lock. Busy is claimed before returning HTTP 202.
        if self.busy or self.stop_event.is_set():
            raise Conflict("Another operation is running or the session is closing")
        self.busy = kind
        self.state = kind
        self.phase = kind.capitalize()
        self.cancel_event.clear()
        if hasattr(self.system, "cancel"):
            self.system.cancel.clear()
        def work():
            try:
                operation()
            except Cancelled:
                with self.lock:
                    self.state, self.phase = "cancelled", "Scan cancelled; no partial candidates retained"
            except (OSError, ValueError) as error:
                with self.lock:
                    self.state, self.phase = "error", str(error)
            except Exception:
                with self.lock:
                    self.state, self.phase = "error", "Operation failed; review manually before retrying"
            finally:
                with self.lock:
                    self.busy = None
        self.worker = threading.Thread(target=work, name="macwipe-operation", daemon=False)
        self.worker.start()

    def start_scan(self):
        with self.lock:
            if self.busy or self.stop_event.is_set():
                raise Conflict("Another operation is running")
            self.report = self.walker = self.plan = self.plan_id = self.results = None
            def work():
                report, walker = scan(self.system, cancelled=self.cancelled, on_progress=self.progress)
                if self.cancelled():
                    raise Cancelled("Scan cancelled")
                with self.lock:
                    self.report, self.walker = report, walker
                    self.state, self.phase = "ready", "Scan complete; review any incomplete checks"
            self.launch("scanning", work)

    def cancel_scan(self):
        with self.lock:
            if self.busy != "scanning":
                raise Conflict("No scan is running")
            self.cancel_event.set()
            self.phase = "Cancelling scan"
        if hasattr(self.system, "stop"):
            self.system.stop()

    def review(self, ids):
        with self.lock:
            if self.busy or self.stop_event.is_set() or self.report is None:
                raise Conflict("Complete a scan first; wait for current operation")
            if not isinstance(ids, list) or not 1 <= len(ids) <= 1000 or any(
                    not isinstance(i, str) or len(i) > 64 for i in ids):
                raise ValueError("Select explicit candidate IDs")
            self.plan = self.plan_id = None
            def work():
                plan = create_plan(self.report, ids, self.system, self.walker)
                with self.lock:
                    self.plan, self.plan_id = plan, secrets.token_urlsafe(24)
                    self.state, self.phase = "review", "Review exactly what will happen"
            self.launch("planning", work)

    def apply(self, plan_id, confirmation):
        with self.lock:
            if self.busy or self.stop_event.is_set():
                raise Conflict("Another operation is running")
            if not self.plan or not isinstance(plan_id, str) or not hmac.compare_digest(plan_id, self.plan_id):
                raise Conflict("Plan is missing, stale, or already used; review again")
            if confirmation != self.plan.confirmation:
                raise ValueError("Exact plan confirmation is required")
            plan = self.plan
            # Consume once under the same lock used to claim execution.
            self.plan = self.plan_id = None
            def work():
                results = execute(plan, self.system, confirmed=True, dry_run=self.dry_run,
                                  cancelled=self.cancelled)
                with self.lock:
                    self.results = results
                    self.report = self.walker = None
                    self.state, self.phase = "results", "Dry-run complete" if self.dry_run else "Actions checked"
            self.launch("executing", work)

    def removal_plan(self):
        with self.lock:
            if self.busy or self.stop_event.is_set():
                raise Conflict("Wait for the current operation")
            path = self.artifact.eligible(self.system)
            self.removal_id = secrets.token_urlsafe(24)
            self.removal_identity = str(path)
            return {"plan_id": self.removal_id, "path": str(path), "confirmation_required": "REMOVE HELPER",
                    "note": "Only this helper moves to Trash. Exported reports are kept. Check Trash after the session closes."}

    def remove(self, plan_id, confirmation):
        with self.lock:
            if self.busy or self.stop_event.is_set():
                raise Conflict("Wait for the current operation")
            if (not self.removal_id or not isinstance(plan_id, str)
                    or not hmac.compare_digest(plan_id, self.removal_id) or confirmation != "REMOVE HELPER"):
                raise ValueError("Review the exact helper and confirm REMOVE HELPER")
            if str(self.artifact.eligible(self.system)) != self.removal_identity:
                raise ValueError("Helper artifact changed; review again")
            self.removal_id = None
            self.stop_event.set()  # Prevent any new operations while removal is scheduled.
        threading.Thread(target=self.shutdown, kwargs={"remove": True}, daemon=False).start()
        return {"status": "requested", "path": self.removal_identity,
                "note": "Removal requested; check Trash in Finder. The browser cannot verify after shutdown."}

    def shutdown(self, remove=False):
        self.stop_event.set()
        self.cancel_event.set()
        if hasattr(self.system, "stop"):
            self.system.stop()
        worker = self.worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout=30)
        if worker and worker.is_alive():
            # Never move an artifact while its worker is still using it.
            remove = False
        if remove:
            try:
                # A fresh command context is needed for the final identity check.
                if hasattr(self.system, "cancel"):
                    self.system.cancel.clear()
                destination = self.artifact.remove(self.system)
                self.phase = "Helper move verified locally: " + destination
            except (OSError, ValueError):
                self.phase = "Helper removal failed; use Finder after quitting"
        if self.server:
            self.server.shutdown()
        with self.lock:
            self.report = self.walker = self.plan = self.plan_id = self.results = None
            self.token = ""  # Forget session credentials and in-memory reports.
            self.state = "stopped"


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, session, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.session = session
        self.authority = f"127.0.0.1:{self.server_address[1]}"
        self.origin = "http://" + self.authority
        session.server = self


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # Never log credentials, request headers, URLs, paths, or reports.

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def permitted(self, mutation=False, authenticate=False):
        host = self.headers.get_all("Host", [])
        origin = self.headers.get_all("Origin", [])
        if host != [self.server.authority]:
            self.send(403, {"error": "Invalid Host"})
            return False
        if (mutation and origin != [self.server.origin]) or (origin and origin != [self.server.origin]):
            self.send(403, {"error": "Invalid Origin"})
            return False
        if self.headers.get("Sec-Fetch-Site") not in (None, "none", "same-origin"):
            self.send(403, {"error": "Cross-site requests are blocked"})
            return False
        if authenticate:
            tokens = self.headers.get_all("X-Macwipe-Token", [])
            expected = self.server.session.token
            if len(tokens) != 1 or not expected or not hmac.compare_digest(tokens[0], expected):
                self.send(401, {"error": "Session authentication required; reopen the helper"})
                return False
        return True

    def do_GET(self):
        route = urlsplit(self.path)
        api = route.path.startswith("/api/")
        if not self.permitted(authenticate=api):
            return
        if route.query:
            self.send(400, {"error": "Query parameters are not accepted"})
            return
        session = self.server.session
        if route.path == "/api/status":
            self.send(200, session.status())
        elif route.path == "/api/report":
            with session.lock:
                self.send(200, session.report or {"sections": {}, "candidates": [], "limitations": []})
        elif route.path in ("/", "/dashboard.js", "/theme.css", "/dashboard.css", "/icons.svg"):
            file = ASSETS / ("dashboard.html" if route.path == "/" else route.path[1:])
            try:
                content = file.read_bytes()
            except FileNotFoundError:
                self.send(404, {"error": "Helper UI asset is not installed"})
                return
            self.send(200, content, mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        else:
            self.send(404, {"error": "Not found"})

    def do_POST(self):
        if not self.permitted(mutation=True, authenticate=True):
            return
        if self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding"):
            self.send(415, {"error": "A bounded JSON body is required"})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1:
                raise ValueError("Exactly one Content-Length is required")
            length = int(lengths[0])
            if not 0 <= length <= 65536:
                raise ValueError("Body size limit exceeded")
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError("Duplicate JSON keys are not accepted")
                    result[key] = value
                return result
            body = json.loads(self.rfile.read(length), object_pairs_hook=unique)
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object")
            session = self.server.session
            schemas = {"/api/scan": set(), "/api/cancel": set(), "/api/plan": {"candidate_ids"},
                       "/api/execute": {"plan_id", "confirmation"}, "/api/quit": set(),
                       "/api/removal-plan": set(), "/api/remove-helper": {"plan_id", "confirmation"},
                       "/api/reveal-helper": set()}
            if self.path not in schemas:
                self.send(404, {"error": "Not found"})
                return
            if set(body) != schemas[self.path]:
                raise ValueError("Only the documented IDs and confirmation fields are accepted")
            if self.path == "/api/scan":
                session.start_scan()
            elif self.path == "/api/cancel":
                session.cancel_scan()
            elif self.path == "/api/plan":
                session.review(body["candidate_ids"])
            elif self.path == "/api/execute":
                session.apply(body["plan_id"], body["confirmation"])
            elif self.path == "/api/removal-plan":
                self.send(200, session.removal_plan())
                return
            elif self.path == "/api/remove-helper":
                self.send(202, session.remove(body["plan_id"], body["confirmation"]))
                return
            elif self.path == "/api/reveal-helper":
                path = session.artifact.check_identity()
                result = session.system.run(["open", "-R", str(path)])
                if not result.ok:
                    raise ValueError(result.problem)
            elif self.path == "/api/quit":
                session.stop_event.set()
                self.send(202, {"status": "requested", "note": "Session is closing; helper and exported reports are kept"})
                threading.Thread(target=session.shutdown, daemon=False).start()
                return
            self.send(202, {"accepted": True})
        except Conflict as error:
            self.send(409, {"error": str(error)})
        except (ValueError, OSError) as error:
            self.send(400, {"error": str(error)})


def smoke(server, session, report_path):
    """Developer-only read-only packaged launch test; no token in the report."""
    def request(method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        connection.request(method, path, json.dumps(body) if body is not None else None,
            {"X-Macwipe-Token": session.token, "Origin": server.origin, "Content-Type": "application/json"})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data
    try:
        assert request("POST", "/api/scan", {})[0] == 202
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            _, state = request("GET", "/api/status")
            if not state["busy"]:
                break
            time.sleep(.1)
        if state["state"] != "ready":
            raise ValueError("Packaged read-only scan failed: " + state["phase"])
        _, report = request("GET", "/api/report")
        summary = {"status": "passed", "read_only": report["read_only"],
                   "sections": list(report["sections"]), "architecture": report["system"]["architecture"],
                   "candidate_count": len(report["candidates"]), "limitation_count": len(report["limitations"])}
        if report_path:
            write_report(report_path, summary)
    finally:
        session.shutdown()


def main(argv=None):
    parser = argparse.ArgumentParser(description="macwipe local browser helper")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke-test", action="store_true", help="Developer read-only packaged launch test")
    parser.add_argument("--smoke-report")
    args = parser.parse_args(argv)
    if os.getuid() == 0:
        raise SystemExit("Do not launch macwipe as root or with sudo")
    if not 0 <= args.port <= 65535:
        parser.error("Invalid port")
    session = Session(dry_run=args.dry_run)
    server = LocalServer(session, args.port)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=session.shutdown, daemon=False).start())
    try:
        if args.smoke_test:
            threading.Thread(target=smoke, args=(server, session, args.smoke_report), daemon=False).start()
        elif not args.no_open:
            # Secret fragment stays on loopback and is removed by the local UI.
            webbrowser.open(server.origin + "/#" + session.token)
        if sys.stdout is not None:
            print("macwipe local helper: " + server.origin, flush=True)
        # Keep shutdown responsive without waking an idle session ten times per second.
        server.serve_forever(poll_interval=.5)
    except KeyboardInterrupt:
        session.shutdown()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
