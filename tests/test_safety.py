import contextlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from mac_scrubber.actions import create_plan, execute, move_to_trash
from dataclasses import replace
from mac_scrubber.cli import confirmation, main, write_report
from mac_scrubber.paths import UnsafePath, Walker, validate
from mac_scrubber.rules import detect, registry, running_matches
from mac_scrubber.scan import launch_inventory, scan
from mac_scrubber.system import CommandResult, System


class FakeSystem:
    macos = True

    def __init__(self, home):
        self.home = home
        self.calls = []
        self.tools = {}
        self.preview = "Would remove: /example/old-version (4 KB)\n"
        self.process_list = []
        self.process_problems = []

    def application_roots(self):
        return [("user_applications", self.home / "Applications")]

    def launch_roots(self):
        return (self.home / "Library/LaunchAgents",)

    def tool(self, name):
        return self.tools.get(name)

    def run(self, argv, timeout=15):
        self.calls.append(tuple(argv))
        if argv[0] == "brew":
            if "--dry-run" in argv:
                return CommandResult(True, self.preview)
            self.preview = ""
            return CommandResult(True)
        if argv[0] == "lsof":
            return CommandResult(False, code=1)
        return CommandResult(False, problem="Mocked unavailable command")

    def capacity(self):
        return {"total_bytes": 100000, "used_bytes": 40000, "free_bytes": 60000}

    def processes(self):
        return self.process_list, self.process_problems


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        (self.home / "Downloads").mkdir()
        self.file = self.home / "Downloads" / 'my work "résumé" 日本語.zip'
        self.file.write_bytes(b"personal work")
        self.system = FakeSystem(self.home)

    def download_plan(self, files=None):
        walker = Walker()
        records, _ = walker.children(self.home / "Downloads")
        candidates, _ = detect(self.system, walker, records)
        report = {"candidates": candidates}
        selected = files or [candidates[0]["id"]]
        return create_plan(report, selected, self.system, walker)

    def test_confirmation_exact_phrase(self):
        plan = self.download_plan()
        for answer in ("yes", "y", "CLEAN", "clean 1", "CLEAN 2", ""):
            self.assertFalse(confirmation(plan, lambda _: answer))
        self.assertTrue(confirmation(plan, lambda _: "CLEAN 1"))

    def test_confirmation_gate_changes_nothing(self):
        with self.assertRaises(PermissionError):
            execute(self.download_plan(), self.system)
        self.assertTrue(self.file.exists())
        self.assertFalse((self.home / ".Trash").exists())

    def test_dry_run_never_mutates_or_executes_cleanup(self):
        result = execute(self.download_plan(), self.system, dry_run=True)
        self.assertTrue(self.file.exists())
        self.assertEqual(result["results"][0]["status"], "dry-run")
        self.assertFalse(self.system.calls)
        self.assertEqual(result["free_bytes_change"], 0)

    def test_spaces_unicode_quotes_trash_and_verify(self):
        result = execute(self.download_plan(), self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "verified")
        destination = Path(result["results"][0]["trash_path"])
        self.assertEqual(destination.name, self.file.name)
        self.assertEqual(destination.read_bytes(), b"personal work")
        self.assertFalse(self.file.exists())
        self.assertTrue((self.home / ".Trash").exists())
        self.assertEqual(self.system.calls[0][-1], str(self.file))

    def test_protected_paths(self):
        for name in ("Library", "Library/Caches", "Library/Application Support",
                     "Library/Containers", "Applications", ".npm", ".Trash"):
            (self.home / name).mkdir(parents=True, exist_ok=True)
        for path in (self.home, Path("/"), self.home / "Downloads", self.home / "Library",
                     self.home / "Library/Application Support", self.home / "Library/Containers",
                     self.home / "Applications", self.home / ".Trash"):
            with self.subTest(path=path), self.assertRaises(UnsafePath):
                validate(path, self.home)

    def test_outside_home_and_parent_traversal(self):
        for path in (self.home.parent, self.home / "Downloads" / ".." / "outside"):
            with self.assertRaises(UnsafePath):
                validate(path, self.home)

    def test_leaf_and_ancestor_symlinks(self):
        link = self.home / "Downloads/link"
        link.symlink_to(self.file)
        with self.assertRaises(UnsafePath):
            validate(link, self.home)
        folder = self.home / "linked"
        folder.symlink_to(self.home / "Downloads", target_is_directory=True)
        with self.assertRaises(UnsafePath):
            validate(folder / self.file.name, self.home)

    def test_descendant_symlink_disqualifies_cache(self):
        cache = self.home / "Library/Caches/pip/http-v2"
        cache.mkdir(parents=True)
        (cache / "link").symlink_to(self.file)
        candidates, _ = detect(self.system, Walker(), [])
        self.assertFalse(candidates)
        self.assertTrue(self.file.exists())

    def test_symlink_swap_after_plan(self):
        plan = self.download_plan()
        outside = self.home / "personal.txt"
        outside.write_text("keep")
        self.file.unlink()
        self.file.symlink_to(outside)
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertEqual(outside.read_text(), "keep")

    def test_change_after_plan(self):
        plan = self.download_plan()
        self.file.write_text("changed")
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertTrue(self.file.exists())

    def test_hardlink_not_eligible(self):
        os.link(self.file, self.home / "personal-link")
        candidates, _ = detect(self.system, Walker(), Walker().children(self.home / "Downloads")[0])
        self.assertFalse(candidates)

    def test_unknown_cache_never_eligible(self):
        folder = self.home / "Library/Caches/unknown-browser-cache"
        folder.mkdir(parents=True)
        (folder / "passwords.db").write_text("keep")
        candidates, _ = detect(self.system, Walker(), [])
        self.assertEqual(candidates, [])

    def test_download_directories_and_apps_not_eligible(self):
        self.file.unlink()
        folder = self.home / "Downloads/archive"
        folder.mkdir()
        (folder / "work.txt").write_text("keep")
        candidates, _ = detect(self.system, Walker(), Walker().children(folder.parent)[0])
        self.assertFalse(candidates)

    def test_unknown_and_duplicate_selection(self):
        walker = Walker()
        candidates, _ = detect(self.system, walker, walker.children(self.home / "Downloads")[0])
        for ids in ([], ["all"], [candidates[0]["id"]] * 2):
            with self.assertRaises(ValueError):
                create_plan({"candidates": candidates}, ids, self.system, walker)

    def test_open_download_blocks(self):
        plan = self.download_plan()
        with patch.object(self.system, "run", return_value=CommandResult(True, "p123\n")):
            result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertTrue(self.file.exists())

    def test_missing_lsof_blocks(self):
        with patch.object(self.system, "run", return_value=CommandResult(False, problem="Missing lsof")):
            result = execute(self.download_plan(), self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")

    def test_partial_failure_other_candidate_succeeds(self):
        second = self.home / "Downloads/second.txt"
        second.write_text("second")
        walker = Walker()
        candidates, _ = detect(self.system, walker, walker.children(second.parent)[0])
        plan = create_plan({"candidates": candidates}, [c["id"] for c in candidates], self.system, walker)
        Path(plan.actions[0].path).write_text("changed")
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual([r["status"] for r in result["results"]], ["failed", "verified"])

    def test_process_identification_ignores_arguments(self):
        processes = [{"pid": 111, "executable": "/safe/tool", "arguments": "/other/tool"},
                     {"pid": 222, "executable": "/other/tool", "arguments": "/safe/tool"}]
        self.assertEqual(running_matches(processes, {"/safe/tool"}), [111])

    def test_process_inventory_incomplete_blocks_cache(self):
        cache = self.home / "Library/Caches/pip/wheels"
        cache.mkdir(parents=True)
        (cache / "test.whl").write_text("wheel")
        walker = Walker()
        candidates, _ = detect(self.system, walker, [])
        plan = create_plan({"candidates": candidates}, ["pip-wheels"], self.system, walker)
        self.system.process_problems = ["identity denied"]
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertTrue(cache.exists())

    def test_brew_dry_run_gating_and_verification(self):
        tool = self.home / "brew"
        tool.write_text("fixture")
        self.system.tools["brew"] = str(tool)
        candidates, _ = detect(self.system, Walker(), [])
        plan = create_plan({"candidates": candidates}, ["brew-cleanup"], self.system, Walker())
        execute(plan, self.system, dry_run=True)
        self.assertNotIn(("brew", "cleanup"), self.system.calls)
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "verified")
        self.assertIn(("brew", "cleanup"), self.system.calls)

    def test_brew_changed_preview_blocks(self):
        tool = self.home / "brew"
        tool.write_text("fixture")
        self.system.tools["brew"] = str(tool)
        candidates, _ = detect(self.system, Walker(), [])
        plan = create_plan({"candidates": candidates}, ["brew-cleanup"], self.system, Walker())
        self.system.preview = "Different preview"
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertNotIn(("brew", "cleanup"), self.system.calls)

    def test_brew_registry_cannot_execute_arbitrary_command(self):
        tool = self.home / "brew"
        tool.write_text("fixture")
        self.system.tools["brew"] = str(tool)
        candidates, _ = detect(self.system, Walker(), [])
        plan = create_plan({"candidates": candidates}, ["brew-cleanup"], self.system, Walker())
        tampered = replace(plan, actions=(replace(plan.actions[0], command=("rm", "-rf", "/")),))
        result = execute(tampered, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertNotIn(("rm", "-rf", "/"), self.system.calls)

    def test_brew_execution_failure_reports_partial(self):
        tool = self.home / "brew"
        tool.write_text("fixture")
        self.system.tools["brew"] = str(tool)
        candidates, _ = detect(self.system, Walker(), [])
        plan = create_plan({"candidates": candidates}, ["brew-cleanup"], self.system, Walker())
        with patch.object(self.system, "run", side_effect=[
                CommandResult(True, self.system.preview),
                CommandResult(False, problem="mock failure"),
                CommandResult(True, self.system.preview)]):
            result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "partial-failure")
        self.assertTrue(result["results"][0]["mutated"])

    def test_cache_busy_verified_executable_blocks(self):
        cache = self.home / "Library/Caches/pip/wheels"
        cache.mkdir(parents=True)
        (cache / "fixture.whl").write_text("wheel")
        walker = Walker()
        candidates, _ = detect(self.system, walker, [])
        plan = create_plan({"candidates": candidates}, ["pip-wheels"], self.system, walker)
        self.system.process_list = [{"pid": 999999, "executable": "/verified/Python"}]
        result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertTrue(cache.exists())

    def test_rule_path_cannot_target_personal_sibling(self):
        folder = self.home / "Library/Caches/personal-work"
        folder.mkdir(parents=True)
        fake = {"id": "fake", "rule_id": "pip-http", "path": str(folder)}
        with self.assertRaises(UnsafePath):
            create_plan({"candidates": [fake]}, ["fake"], self.system, Walker())

    def test_interactive_all_is_diagnostics_only(self):
        from mac_scrubber.cli import interactive
        answers = iter(["all", "quit"])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(interactive(self.system, input_fn=lambda _: next(answers)), 0)
        self.assertTrue(self.file.exists())
        self.assertFalse((self.home / ".Trash").exists())
        self.assertNotIn(("brew", "cleanup"), self.system.calls)

    def test_report_symlink_rejected(self):
        link = self.home / "link.report.json"
        link.symlink_to(self.file)
        with self.assertRaises(FileExistsError):
            write_report(link, {})
        self.assertEqual(self.file.read_bytes(), b"personal work")

    def test_rename_failure_does_not_delete_source(self):
        plan = self.download_plan()
        with patch("mac_scrubber.actions.os.rename", side_effect=OSError("cross-device")):
            result = execute(plan, self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertTrue(self.file.exists())
        self.assertEqual(list((self.home / ".Trash").iterdir()), [])

    def test_registry_unique(self):
        self.assertEqual(len(registry()), 3)

    def test_missing_tool_and_timeout_graceful(self):
        system = System(self.home)
        with patch.object(system, "tool", return_value=None):
            result = system.run(["missing"])
            self.assertFalse(result.ok)
        with patch.object(system, "tool", return_value="/fixture/tool"), \
             patch("subprocess.run", side_effect=subprocess.TimeoutExpired(["tool"], 1)):
            self.assertFalse(system.run(["tool"]).ok)

    def test_native_commands_use_arrays_and_disable_telemetry(self):
        system = System(self.home)
        with patch.object(system, "tool", return_value="/fixture/brew"), \
             patch("subprocess.run") as run:
            run.return_value.returncode = 0
            system.run(["brew", "cleanup", "--dry-run"])
            self.assertEqual(run.call_args.args[0], ["/fixture/brew", "cleanup", "--dry-run"])
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs["env"]["HOMEBREW_NO_ANALYTICS"], "1")

    def test_bounded_and_no_follow_inventory(self):
        folder = self.home / "many"
        folder.mkdir()
        for n in range(20):
            (folder / str(n)).write_text("fixture")
        walker = Walker(max_entries=3)
        measurement = walker.measure(folder)
        self.assertFalse(measurement["complete"])
        self.assertLessEqual(len(measurement["manifest"]), 3)
        link = self.home / "link"
        link.symlink_to(folder)
        self.assertFalse(Walker().measure(link)["complete"])

    def test_subtree_measurement_reused(self):
        parent = self.home / "Library/Caches/pip"
        child = parent / "wheels"
        child.mkdir(parents=True)
        (child / "wheel").write_text("data")
        walker = Walker()
        walker.measure(parent)
        remaining = walker.remaining
        self.assertTrue(walker.measure(child)["complete"])
        self.assertEqual(walker.remaining, remaining)

    def test_permission_denied_explained(self):
        with patch("mac_scrubber.paths.fingerprint", side_effect=PermissionError):
            result = Walker().measure(self.file)
        self.assertFalse(result["complete"])
        self.assertIn("PermissionError", " ".join(result["problems"]))

    def test_scan_all_never_cleans(self):
        report, _ = scan(self.system, network=True)
        self.assertTrue(report["read_only"])
        self.assertEqual(set(report["sections"]), {"Storage", "Caches", "Applications", "Startup", "Performance", "Privacy"})
        self.assertTrue(self.file.exists())
        self.assertFalse((self.home / ".Trash").exists())
        self.assertNotIn(("brew", "cleanup"), self.system.calls)
        self.assertNotIn(("launchctl", "disable"), self.system.calls)

    def test_unsupported_os(self):
        self.system.macos = False
        report, _ = scan(self.system)
        self.assertTrue(report["limitations"])
        with self.assertRaises(ValueError):
            execute(self.download_plan(), self.system, confirmed=True)

    def test_launch_inventory_no_program_arguments(self):
        import plistlib
        root = self.home / "Library/LaunchAgents"
        root.mkdir(parents=True)
        with (root / "third.plist").open("wb") as stream:
            plistlib.dump({"Label": "example.agent", "ProgramArguments": ["tool", "secret"]}, stream)
        items, problems = launch_inventory(root)
        self.assertFalse(problems)
        self.assertFalse(items[0]["identity_verified"])
        self.assertNotIn("secret", json.dumps(items))

    def test_json_scan_and_private_reports(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["scan", "--json"], self.system), 0)
        self.assertTrue(json.loads(output.getvalue())["read_only"])
        report = self.home / "out.report.json"
        write_report(report, {"fixture": True})
        self.assertEqual(report.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            write_report(report, {})

    def test_apply_noninteractive_has_no_bypass(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), \
             patch("sys.stdin.isatty", return_value=False):
            self.assertEqual(main(["apply", "--select", "download-1"], self.system), 1)
        self.assertTrue(self.file.exists())

    def test_cli_apply_dry_run_json(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = main(["apply", "--select", "download-1", "--dry-run", "--json"], self.system)
        self.assertEqual(status, 0)
        self.assertTrue(json.loads(output.getvalue())["execution"]["dry_run"])
        self.assertTrue(self.file.exists())

    def test_trash_symlink_rejected(self):
        (self.home / ".Trash").symlink_to(self.home / "Downloads", target_is_directory=True)
        result = execute(self.download_plan(), self.system, confirmed=True)
        self.assertEqual(result["results"][0]["status"], "failed")
        self.assertTrue(self.file.exists())

    def test_trash_collision_no_overwrite(self):
        first = move_to_trash(self.file, self.system)
        self.file.write_text("second version")
        second = move_to_trash(self.file, self.system)
        self.assertNotEqual(first, second)
        self.assertEqual(Path(first).read_bytes(), b"personal work")
        self.assertEqual(Path(second).read_text(), "second version")


if __name__ == "__main__":
    unittest.main()
