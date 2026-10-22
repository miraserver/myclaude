"""Installer regression tests; run with unittest and no added dependencies."""

import copy
import contextlib
import io
import os
import subprocess
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("installer_under_test", ROOT / "install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerJsonTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.ctx = {
            "install_dir": self.root,
            "config_dir": self.root,
            "status_file": self.root / "installed_modules.json",
            "log_file": self.root / "install.log",
        }
        home = mock.patch.object(installer.Path, "home", return_value=self.root)
        home.start()
        self.addCleanup(home.stop)
        environment = mock.patch.dict(os.environ, {"HOME": str(self.root), "USERPROFILE": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
        self.models = self.root / ".codeagent" / "models.json"
        self.hooks = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo ok"}]}]}}

    def write_bom(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8-sig")

    def read_json(self, path):
        return json.loads(path.read_text(encoding="utf-8-sig"))

    def test_default_configs_install_codeagent_dependency_safely(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8-sig"))
        for scenario in ("fresh", "matching CLAUDE.md", "user CLAUDE.md", "existing skill"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temporary:
                install_dir = Path(temporary)
                ctx = {**self.ctx, "install_dir": install_dir, "config_dir": ROOT,
                       "status_file": install_dir / "installed_modules.json"}
                claude = install_dir / "CLAUDE.md"
                skill = install_dir / "skills/codeagent/SKILL.md"
                if scenario == "matching CLAUDE.md":
                    claude.write_bytes((ROOT / "memorys/CLAUDE.md").read_bytes())
                if scenario == "user CLAUDE.md":
                    claude.write_bytes(b"user instructions\n")
                if scenario == "existing skill":
                    skill.parent.mkdir(parents=True)
                    skill.write_bytes(b"user skill\n")
                result = installer.execute_module("harness", config["modules"]["harness"], ctx)
                self.assertEqual(result["status"], "success")
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    installer.install_default_configs(ctx)
                if scenario == "user CLAUDE.md":
                    self.assertEqual(claude.read_bytes(), b"user instructions\n")
                    self.assertFalse(skill.exists())
                else:
                    self.assertEqual(claude.read_bytes(), (ROOT / "memorys/CLAUDE.md").read_bytes())
                    expected = b"user skill\n" if scenario == "existing skill" else (ROOT / "skills/codeagent/SKILL.md").read_bytes()
                    self.assertEqual(skill.read_bytes(), expected)
                self.assertEqual("Installed codeagent skill (required by CLAUDE.md)" in output.getvalue(),
                                 scenario in ("fresh", "matching CLAUDE.md"))
                result = installer.uninstall_module("harness", config["modules"]["harness"], ctx)
                self.assertEqual(result["status"], "success")
                if scenario != "user CLAUDE.md":
                    self.assertTrue(skill.exists())

    def test_wrapper_path_is_platform_specific(self):
        with mock.patch.object(installer.sys, "platform", "win32"), mock.patch.dict(
            "os.environ", {"USERPROFILE": str(self.root)}
        ):
            self.assertEqual(
                installer._wrapper_bin_path(self.root),
                self.root / "bin" / "codeagent-wrapper.exe",
            )
        with mock.patch.object(installer.sys, "platform", "linux"):
            self.assertEqual(
                installer._wrapper_bin_path(self.root),
                self.root / "bin" / "codeagent-wrapper",
            )

    def test_course_subagent_install_and_uninstall_preserve_foreign_agent(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8-sig"))
        course = config["modules"]["course"]
        ctx = {**self.ctx, "config_dir": ROOT, "_wrapper_installed": True}
        agent = self.root / "agents" / "dev-plan-generator.md"
        other = self.root / "agents" / "other.md"
        other.parent.mkdir(parents=True)
        other.write_bytes(b"foreign agent\n")

        # Skip the binary installer while exercising the real course operations.
        with mock.patch.object(installer.subprocess, "Popen") as popen:
            result = installer.execute_module("course", course, ctx)
        popen.assert_not_called()
        self.assertEqual(result["status"], "success")
        self.assertEqual(
            agent.read_bytes(),
            (ROOT / "skills/dev/agents/dev-plan-generator.md").read_bytes(),
        )

        result = installer.uninstall_module("course", course, ctx)
        self.assertEqual(result["status"], "success")
        self.assertFalse(agent.exists())
        self.assertEqual(other.read_bytes(), b"foreign agent\n")

    def assert_corrupt_unchanged(self, path, action):
        path.parent.mkdir(parents=True, exist_ok=True)
        for content in (b'{"user": true,', b'\xef\xbb\xbf{"user":', b'\xff'):
            with self.subTest(path=path.name, content=content):
                path.write_bytes(content)
                with self.assertRaises(ValueError) as raised:
                    action()
                self.assertIn(str(path), str(raised.exception))
                self.assertIn("Invalid JSON", str(raised.exception))
                self.assertEqual(path.read_bytes(), content)

    def test_copy_file_uninstall_checks_source_bytes(self):
        for scenario in ("identical", "user", "missing", "missing source", "unreadable source"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ctx = {**self.ctx, "install_dir": root / "install", "config_dir": root}
                source = root / "source.md"
                target = ctx["install_dir"] / "agents/dev-plan-generator.md"
                source.write_bytes(b"\x00\xff\r\n")
                target.parent.mkdir(parents=True)
                op = {"type": "copy_file", "source": "source.md", "target": "agents/dev-plan-generator.md"}
                with mock.patch.dict("os.environ", {"HOME": str(root), "USERPROFILE": str(root)}):
                    if scenario == "user":
                        target.write_bytes(b"user agent\n")
                    installer.op_copy_file(op, ctx)
                    self.assertEqual(target.read_bytes(), b"user agent\n" if scenario == "user" else source.read_bytes())
                    if scenario == "missing":
                        target.unlink()
                    if "source" in scenario:
                        source.unlink()
                    if scenario == "unreadable source":
                        source.mkdir()
                    result = installer.uninstall_module("demo", {"operations": [op]}, ctx)
                self.assertEqual(result["status"], "success")
                if scenario == "user":
                    self.assertEqual(target.read_bytes(), b"user agent\n")
                    self.assertIn(f"Keeping {target}: differs from the installed copy", self.ctx["log_file"].read_text(encoding="utf-8"))
                    self.assertNotIn(str(target), result["removed_paths"])
                else:
                    self.assertFalse(target.exists())

    def test_update_overwrites_copy_targets_but_preserves_unowned_merge_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            (source / "merge" / "commands").mkdir(parents=True)
            (source / "skill").mkdir()
            (source / "skill" / "SKILL.md").write_text("NEW", encoding="utf-8")
            (source / "merge" / "commands" / "owned.md").write_text("NEW OWNED", encoding="utf-8")
            (source / "merge" / "commands" / "foreign.md").write_text("MODULE FOREIGN", encoding="utf-8")
            install = root / "install"
            (install / "skills/demo").mkdir(parents=True)
            (install / "skills/demo/SKILL.md").write_text("OLD", encoding="utf-8")
            (install / "commands").mkdir()
            (install / "commands/owned.md").write_text("OLD OWNED", encoding="utf-8")
            (install / "commands/foreign.md").write_text("USER", encoding="utf-8")
            ctx = {**self.ctx, "install_dir": install, "config_dir": source,
                   "status_file": install / "installed_modules.json", "force": True, "explicit_force": False}
            ctx["status_file"].write_text(json.dumps({"modules": {"demo": {
                "status": "success", "merge_dir_files": ["commands/owned.md"]}}}), encoding="utf-8")
            module = {"operations": [
                {"type": "copy_dir", "source": "skill", "target": "skills/demo"},
                {"type": "merge_dir", "source": "merge"},
            ]}
            result = installer.execute_module("demo", module, ctx)
            self.assertEqual(result["status"], "success")
            self.assertEqual((install / "skills/demo/SKILL.md").read_text(), "NEW")
            self.assertEqual((install / "commands/owned.md").read_text(), "NEW OWNED")
            self.assertEqual((install / "commands/foreign.md").read_text(), "USER")

    def test_bom_settings_load_and_hook_merge_preserve_user_keys(self):
        path = self.root / "settings.json"
        original = {"env": {"USER_OPTION": "keep"}, "permissions": {"allow": ["Read"]}}
        self.write_bom(path, original)
        self.assertEqual(installer.load_settings(self.ctx), original)
        installer.merge_hooks_to_settings("demo", self.hooks, self.ctx)
        merged = self.read_json(path)
        for key, value in original.items():
            self.assertEqual(merged[key], value)
        self.assertEqual(merged["hooks"]["Stop"][0]["__module__"], "demo")

    def test_invalid_settings_load_merge_and_unmerge_leave_bytes_unchanged(self):
        path = self.root / "settings.json"
        for action in (
            lambda: installer.load_settings(self.ctx),
            lambda: installer.merge_hooks_to_settings("demo", self.hooks, self.ctx),
            lambda: installer.unmerge_hooks_from_settings("demo", self.ctx),
        ):
            self.assert_corrupt_unchanged(path, action)

    def test_bom_models_merge_and_unmerge_preserve_user_keys(self):
        original = {"custom": "keep", "agents": {"user": {"model": "mine"}}}
        self.write_bom(self.models, original)
        installer.merge_agents_to_models("demo", {"new": {"backend": "codex"}}, self.ctx)
        merged = self.read_json(self.models)
        self.assertEqual(merged["custom"], "keep")
        self.assertEqual(merged["agents"]["user"], original["agents"]["user"])
        self.assertEqual(merged["agents"]["new"]["__module__"], "demo")
        self.write_bom(self.models, merged)
        installer.unmerge_agents_from_models("demo", self.ctx)
        self.assertEqual(self.read_json(self.models), original)

    def test_invalid_models_merge_and_unmerge_leave_bytes_unchanged(self):
        for action in (
            lambda: installer.merge_agents_to_models("demo", {"new": {}}, self.ctx),
            lambda: installer.unmerge_agents_from_models("demo", self.ctx),
        ):
            self.assert_corrupt_unchanged(self.models, action)

    def test_models_template_bom_and_invalid_json(self):
        template = self.root / "templates" / "models.json.example"
        action = lambda: installer.merge_agents_to_models("demo", {"new": {}}, self.ctx)
        self.assert_corrupt_unchanged(template, action)
        self.assertFalse(self.models.exists())
        self.write_bom(template, {"custom": "keep", "agents": {"template": {}}})
        action()
        models = self.read_json(self.models)
        self.assertEqual(models["custom"], "keep")
        self.assertEqual(set(models["agents"]), {"new"})

    def test_bom_installed_status_load_and_update_preserve_user_keys(self):
        path = self.ctx["status_file"]
        original = {"custom": "keep", "modules": {"demo": {}, "other": {"status": "success"}}}
        self.write_bom(path, original)
        self.assertEqual(installer.load_installed_status(self.ctx), original)
        installer.update_status_after_uninstall(["demo"], self.ctx)
        updated = self.read_json(path)
        self.assertEqual(updated["custom"], "keep")
        self.assertEqual(updated["modules"], {"other": {"status": "success"}})

    def test_invalid_installed_status_load_and_writes_leave_bytes_unchanged(self):
        for action in (
            lambda: installer.load_installed_status(self.ctx),
            lambda: installer.update_status_after_uninstall(["demo"], self.ctx),
            lambda: installer.write_status([], self.ctx),
        ):
            self.assert_corrupt_unchanged(self.ctx["status_file"], action)

    def test_generic_json_merge_bom_and_invalid_files(self):
        source = self.root / "source.json"
        target = self.root / "target.json"
        op = {"source": "source.json", "target": "target.json"}
        action = lambda: installer.op_merge_json(op, self.ctx)
        self.write_bom(source, {"new": True})
        self.assert_corrupt_unchanged(target, action)
        self.write_bom(target, {"custom": "keep"})
        before = target.read_bytes()
        self.assert_corrupt_unchanged(source, action)
        self.assertEqual(target.read_bytes(), before)
        self.write_bom(source, {"new": True})
        action()
        self.assertEqual(self.read_json(target), {"custom": "keep", "new": True})

    def test_missing_files_retain_defaults(self):
        self.assertEqual(installer.load_settings(self.ctx), {})
        self.assertEqual(installer.load_installed_status(self.ctx), {"modules": {}})
        installer.unmerge_agents_from_models("demo", self.ctx)
        self.assertFalse(self.models.exists())
        installer.merge_agents_to_models("demo", {}, self.ctx)
        self.assertEqual(self.read_json(self.models), {
            "default_backend": "codex",
            "default_model": "gpt-6.1-sol",
            "backends": {},
            "agents": {},
        })


class InstallerSchemaTests(unittest.TestCase):
    def setUp(self):
        try:
            import jsonschema
        except ImportError:
            self.skipTest("jsonschema is not installed")
        self.jsonschema = jsonschema
        self.schema = json.loads((ROOT / "config.schema.json").read_text(encoding="utf-8-sig"))
        self.config = json.loads((ROOT / "config.json").read_text(encoding="utf-8-sig"))

    def test_repository_config_validates(self):
        self.jsonschema.validate(self.config, self.schema)
        self.assertEqual(installer.load_config(str(ROOT / "config.json")), self.config)

    def test_unknown_module_key_is_rejected(self):
        config = copy.deepcopy(self.config)
        config["modules"]["omo"]["agentz"] = {}
        with self.assertRaises(self.jsonschema.ValidationError):
            self.jsonschema.validate(config, self.schema)

    def test_agent_preset_fields_and_types(self):
        preset = {name: "value" for name in (
            "backend", "model", "reasoning", "prompt_file", "description", "base_url", "api_key"
        )}
        preset.update(yolo=True, allowed_tools=["Read"], disallowed_tools=["Write"])
        self.config["modules"]["omo"]["agents"] = {"custom": preset}
        self.jsonschema.validate(self.config, self.schema)
        for key, value in (("model", 1), ("yolo", "true"), ("allowed_tools", [1]),
                           ("disallowed_tools", "Read"), ("backned", "codex")):
            with self.subTest(key=key):
                invalid = copy.deepcopy(self.config)
                invalid["modules"]["omo"]["agents"]["custom"][key] = value
                with self.assertRaises(self.jsonschema.ValidationError):
                    self.jsonschema.validate(invalid, self.schema)


class PackageTests(unittest.TestCase):
    def test_schema_is_packaged(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8-sig"))
        self.assertIn("config.schema.json", package["files"])


class InstallerRequirementsTests(unittest.TestCase):
    setUp = InstallerJsonTests.setUp
    read_json = InstallerJsonTests.read_json

    def save(self, path, data):
        installer._save_json(path, data)

    def run_main(self, modules, *args):
        config = {"modules": modules}
        path = self.root / "config.json"
        self.save(path, config)
        output = io.StringIO()
        with mock.patch.object(installer, "load_config", return_value=config), \
                mock.patch.object(installer, "install_default_configs"), \
                mock.patch.object(installer, "print_post_install_info"), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = installer.main(["--config", str(path), "--install-dir", str(self.root), *args])
        return code, output.getvalue()

    def foreign_hooks(self):
        return [{**({"__module__": owner} if owner != "user" else {}), "hooks": [{"command": command}]} for owner, command in (
            ("herdr", r'python "C:\herdr\stop.py"'),
            ("orca", r'cmd /c C:\orca\hook.cmd'),
            ("user", r'echo C:\users\me\notes'))]

    def test_i1_rollback_restores_merges_overwrites_and_status_even_with_force(self):
        for force in (False, True):
            with self.subTest(force=force):
                settings = self.root / "settings.json"
                original = {"hooks": {"Stop": self.foreign_hooks()}, "user": "keep"}
                self.save(settings, original)
                models = {"agents": {"foreign": {"model": "mine"}}}
                self.save(self.models, models)
                before_settings, before_models = settings.read_bytes(), self.models.read_bytes()
                source = self.root / "source"
                source.mkdir(exist_ok=True)
                self.save(source / "hooks.json", self.hooks)
                merge = self.root / "merge" / "agents"
                merge.mkdir(parents=True, exist_ok=True)
                (merge / "new.md").write_text("new")
                (merge / "old.md").write_text("replacement")
                old = self.root / "agents" / "old.md"
                old.parent.mkdir(exist_ok=True)
                old.write_text("original")
                previous = {"modules": {"existing": {"status": "success"}}}
                self.save(self.ctx["status_file"], previous)
                modules = {
                    "first": {"operations": [
                        {"type": "copy_dir", "source": "source", "target": "skills/first"},
                        {"type": "merge_dir", "source": "merge"}],
                        "agents": {"develop": {"model": "new"}}},
                    "broken": {"operations": [{"type": "invalid"}]}}
                code, _ = self.run_main(modules, "--module", "first,broken", *(["--force"] if force else []))
                self.assertEqual(code, 0 if force else 1)
                self.assertEqual(settings.read_bytes(), before_settings)
                self.assertEqual(self.models.read_bytes(), before_models)
                self.assertEqual(old.read_text(), "original")
                self.assertFalse((old.parent / "new.md").exists())
                self.assertFalse((self.root / "skills/first").exists())
                self.assertEqual(self.read_json(self.ctx["status_file"])["modules"], previous["modules"])

    def test_i1_failed_module_merges_are_undone(self):
        self.save(self.root / "settings.json", {"hooks": {"Stop": self.foreign_hooks()}})
        before = (self.root / "settings.json").read_bytes()
        source = self.root / "hooks-source"
        source.mkdir()
        self.save(source / "hooks.json", self.hooks)
        module = {"operations": [{"type": "copy_dir", "source": "hooks-source", "target": "hooks/demo"}],
                  "agents": {"agent": {"model": "new"}}}
        merge_agents = installer.merge_agents_to_models
        def fail_after_write(*args):
            merge_agents(*args)
            raise OSError("injected failure after models write")
        with mock.patch.object(installer, "merge_agents_to_models", side_effect=fail_after_write):
            code, _ = self.run_main({"demo": module}, "--module", "demo")
        self.assertEqual(code, 1)
        self.assertEqual((self.root / "settings.json").read_bytes(), before)
        self.assertFalse(self.models.exists())
        self.assertFalse((self.root / "hooks/demo").exists())

    def test_i2_reinstall_and_update_replace_old_hooks_preserving_foreign_commands(self):
        foreign = self.foreign_hooks()
        self.save(self.root / "settings.json", {"hooks": {"Stop": foreign}})
        source = self.root / "hook-source"
        source.mkdir()
        module = {"operations": [{"type": "copy_dir", "source": "hook-source", "target": "hooks/demo"}]}
        for index, extra in enumerate(([], [], ["--update"])):
            hooks = {"hooks": {"Stop": [{"hooks": [{"command": f"echo version-{index}"}]}]}}
            self.save(source / "hooks.json", hooks)
            code, _ = self.run_main({"demo": module}, "--module", "demo", *extra)
            self.assertEqual(code, 0)
            actual = self.read_json(self.root / "settings.json")["hooks"]["Stop"]
            self.assertEqual(actual[:3], foreign)
            self.assertEqual(len(actual), 4)
            self.assertEqual(actual[-1]["hooks"][0]["command"], f"echo version-{index}")

    def test_i3_hash_matches_cli_canonical_defaults_and_protects_edits(self):
        cfg = {"model": "original", "nested": {"z": 1, "a": ["value"]}}
        # SHA256 of the exact canonical JSON produced by cli.js.
        import hashlib
        expected = hashlib.sha256(b'{"model":"original","nested":{"a":["value"],"z":1}}').hexdigest()[:12]
        self.assertEqual(installer.agent_defaults_hash(cfg), expected)
        installer.merge_agents_to_models("demo", {"agent": cfg}, self.ctx)
        models = self.read_json(self.models)
        self.assertEqual(models["agents"]["agent"]["__hash__"], expected)
        models["agents"]["agent"]["model"] = "user edited"
        self.save(self.models, models)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            installer.merge_agents_to_models("demo", {"agent": {"model": "update"}}, self.ctx)
        self.assertIn("user-edited agent: agent", output.getvalue())
        self.assertEqual(self.read_json(self.models), models)
        installer.unmerge_agents_from_models("demo", self.ctx)
        self.assertEqual(self.read_json(self.models), models)

    def test_i3_unmodified_agents_update_and_uninstall_foreign_agents_survive(self):
        self.save(self.models, {"agents": {"foreign": {"model": "mine"}}})
        for model in ("one", "two"):
            installer.merge_agents_to_models("demo", {"agent": {"model": model}, "foreign": {"model": "bad"}}, self.ctx)
            agent = self.read_json(self.models)["agents"]["agent"]
            self.assertEqual(agent["model"], model)
            self.assertEqual(agent["__hash__"], installer.agent_defaults_hash(agent))
        installer.unmerge_agents_from_models("demo", self.ctx)
        self.assertEqual(self.read_json(self.models)["agents"], {"foreign": {"model": "mine"}})

    def test_i4_reinstall_retains_owned_merge_files_for_uninstall(self):
        source = self.root / "merge/agents"
        source.mkdir(parents=True)
        (source / "first.md").write_text("first")
        module = {"operations": [{"type": "merge_dir", "source": "merge"}]}
        for name in ("first", "second"):
            (source / f"{name}.md").write_text(name)
            self.assertEqual(self.run_main({"demo": module}, "--module", "demo")[0], 0)
        owned = self.read_json(self.ctx["status_file"])["modules"]["demo"]["merge_dir_files"]
        self.assertEqual(set(owned), {"agents/first.md", "agents/second.md"})
        self.assertEqual(self.run_main({"demo": module}, "--uninstall", "--module", "demo")[0], 0)
        self.assertFalse((self.root / "agents/first.md").exists())
        self.assertFalse((self.root / "agents/second.md").exists())

    def test_i5_update_without_status_makes_no_changes(self):
        agent = self.root / "agents/debug.md"
        agent.parent.mkdir()
        agent.write_bytes(b"user file")
        module = {"operations": [{"type": "copy_file", "source": "missing", "target": "agents/debug.md"}]}
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        # Place config first so its creation isn't counted as an installer change.
        self.save(self.root / "config.json", {"modules": {"essentials": module}})
        before[Path("config.json")] = (self.root / "config.json").read_bytes()
        code, output = self.run_main({"essentials": module}, "--update")
        self.assertEqual(code, 0)
        self.assertIn("--module", output)
        self.assertEqual({p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}, before)

    def test_i5_update_uses_only_recorded_modules(self):
        self.save(self.ctx["status_file"], {"modules": {"recorded": {"status": "success"}}})
        (self.root / "agents").mkdir()
        (self.root / "agents/debug.md").write_text("user")
        modules = {"recorded": {"operations": []}, "essentials": {"operations": [
            {"type": "copy_file", "source": "missing", "target": "agents/debug.md"}]}}
        code, _ = self.run_main(modules, "--update")
        self.assertEqual(code, 0)
        self.assertEqual(set(self.read_json(self.ctx["status_file"])["modules"]), {"recorded"})
        self.assertEqual((self.root / "agents/debug.md").read_text(), "user")

    def test_i7_windows_resolves_working_python_and_preserves_foreign_hooks(self):
        for successful, expected in ((1, "python"), (2, "py -3")):
            with self.subTest(expected=expected), mock.patch.object(installer.sys, "platform", "win32"), \
                    mock.patch.dict(os.environ, {"MYCLAUDE_PYTHON": ""}), \
                    mock.patch.object(installer.subprocess, "run") as run:
                run.side_effect = [subprocess.CompletedProcess([], 1)] * successful + [subprocess.CompletedProcess([], 0)]
                foreign = self.foreign_hooks()
                self.save(self.root / "settings.json", {"hooks": {"Stop": foreign}})
                hooks = {"hooks": {"Stop": [{"hooks": [{"command": 'python3 "C:/hook.py"'}]}]}}
                self.ctx.pop("python_command", None)
                installer.merge_hooks_to_settings("demo", hooks, self.ctx)
                actual = self.read_json(self.root / "settings.json")["hooks"]["Stop"]
                self.assertEqual(actual[:3], foreign)
                self.assertEqual(actual[-1]["hooks"][0]["command"], expected + ' "C:/hook.py"')
                self.assertEqual([call.args[0] for call in run.call_args_list],
                                 [["python3", "-c", "import sys"], ["python", "-c", "import sys"],
                                  ["py", "-3", "-c", "import sys"]][:successful + 1])

    def test_i8_unknown_module_reports_available_modules_without_traceback(self):
        for flags in ([], ["--update"], ["--uninstall"]):
            code, output = self.run_main({"demo": {}}, "--module", "nope", *flags)
            self.assertEqual(code, 1)
            self.assertIn("Unknown module: nope", output)
            self.assertIn("Available Modules", output)
            self.assertIn("demo", output)
            self.assertNotIn("Traceback", output)


    def test_i5_explicit_module_cannot_update_without_status(self):
        code, output = self.run_main({"demo": {"operations": []}}, "--update", "--module", "demo")
        self.assertEqual(code, 0)
        self.assertIn("demo is not installed; run without --update to install it", output)
        self.assertFalse(self.ctx["status_file"].exists())

    def test_i1_update_rollback_never_persists_rolled_back_success(self):
        for force in (False, True):
            with self.subTest(force=force):
                source = self.root / "update-source"
                source.mkdir(exist_ok=True)
                self.save(source / "hooks.json", self.hooks)
                settings = self.root / "settings.json"
                self.save(settings, {"hooks": {"Stop": self.foreign_hooks()}})
                before = settings.read_bytes()
                previous = {"modules": {name: {"status": "success", "version": "old"}
                                         for name in ("first", "broken")}}
                self.save(self.ctx["status_file"], previous)
                modules = {"first": {"operations": [{"type": "copy_dir", "source": "update-source", "target": "hooks/first"}]},
                           "broken": {"operations": [{"type": "invalid"}]}}
                code, _ = self.run_main(modules, "--update", *(["--force"] if force else []))
                self.assertEqual(code, 0 if force else 1)
                self.assertEqual(settings.read_bytes(), before)
                self.assertFalse((self.root / "hooks/first").exists())
                self.assertEqual(self.read_json(self.ctx["status_file"])["modules"], previous["modules"])

    def test_i2_preserves_untagged_hooks_inside_module_root(self):
        root = (self.root / "skills/demo").as_posix()
        foreign = self.foreign_hooks()
        self.save(self.root / "settings.json", {"hooks": {"Stop": foreign + [
            {"hooks": [{"command": f'python3 "{root}/old.py"'}]}]}})
        installer.merge_hooks_to_settings("demo", self.hooks, self.ctx, plugin_roots=[root])
        actual = self.read_json(self.root / "settings.json")["hooks"]["Stop"]
        self.assertEqual(actual[:3], foreign)
        self.assertEqual(len(actual), 5)
        self.assertEqual(actual[-1]["hooks"][0]["command"], "echo ok")


if __name__ == "__main__":
    unittest.main()


class FollowupRequirementsTests(unittest.TestCase):
    setUp = InstallerJsonTests.setUp
    read_json = InstallerJsonTests.read_json
    save = InstallerRequirementsTests.save
    run_main = InstallerRequirementsTests.run_main

    def test_legacy_hint_and_command(self):
        modules = {name: {"operations": [{"type": "copy_dir", "target": f"skills/{name}"}]}
                   for name in ("do", "harness")}
        for name in modules:
            (self.root / "skills" / name).mkdir(parents=True)
        code, output = self.run_main(modules, "--update")
        self.assertEqual(code, 0)
        self.assertIn("No installation status found. Detected: do, harness. Run: python install.py --module do,harness --update", output)
        self.assertFalse(self.ctx["status_file"].exists())

    def test_update_status_and_explicit_scope(self):
        entries = {"legacy": {}, "good": {"status": "installed"}, "ok": {"status": "success"},
                   "bad": {"status": "failed"}, "undone": {"status": "rolled_back"}}
        modules = {name: {"operations": []} for name in (*entries, "absent")}
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                self.save(self.ctx["status_file"], {"modules": entries})
                with mock.patch.object(installer, "execute_module", side_effect=lambda name, cfg, ctx:
                                       {"module": name, "status": "success"}) as execute:
                    code, output = self.run_main(modules, "--update", "--force",
                        *(["--module", "legacy,bad,undone,absent"] if explicit else []))
                self.assertEqual(code, 0)
                self.assertEqual([c.args[0] for c in execute.call_args_list],
                                 ["legacy"] if explicit else ["legacy", "good", "ok"])
                for name in (["bad", "undone", "absent"] if explicit else ["bad", "undone"]):
                    self.assertIn(f"{name} is not installed; run without --update to install it", output)

    def test_python_resolution_cached_across_hook_merges(self):
        hooks = {"hooks": {"Stop": [{"hooks": [{"command": f"python3 hook{i}.py"} for i in range(4)]}],
                           "SessionStart": [{"hooks": [{"command": "python3 start.py"}]}]}}
        with mock.patch.object(installer, "resolve_python_command", return_value="py -3") as resolve:
            installer.merge_hooks_to_settings("demo", hooks, self.ctx)
            installer.merge_hooks_to_settings("other", hooks, self.ctx)
        resolve.assert_called_once_with()
        actual = self.read_json(self.root / "settings.json")["hooks"]
        for entries in actual.values():
            for entry in entries:
                for hook in entry["hooks"]:
                    self.assertTrue(hook["command"].startswith("py -3 "))


class OwnershipRegressionTests(unittest.TestCase):
    setUp = InstallerJsonTests.setUp
    save = InstallerRequirementsTests.save
    def test_existing_copy_dir_fills_missing_and_preserves_modified(self):
        source = self.root / "source"
        target = self.root / "hooks"
        source.mkdir(); target.mkdir()
        (source / "new.py").write_bytes(b"new")
        (source / "edited.py").write_bytes(b"original")
        (target / "edited.py").write_bytes(b"user")
        module = {"operations": [{"type": "copy_dir", "source": "source", "target": "hooks"}]}
        installer.execute_module("demo", module, self.ctx)
        self.assertEqual((target / "new.py").read_bytes(), b"new")
        self.assertEqual((target / "edited.py").read_bytes(), b"user")
        installer.uninstall_module("demo", module, self.ctx)
        self.assertFalse((target / "new.py").exists())
        self.assertEqual((target / "edited.py").read_bytes(), b"user")

    def test_update_only_overwrites_recorded_merge_files(self):
        source = self.root / "source/agents"
        source.mkdir(parents=True)
        target = self.root / "agents"
        target.mkdir()
        for name in ("owned", "user"):
            (source / (name + ".md")).write_text("new")
            (target / (name + ".md")).write_text("old")
        self.save(self.ctx["status_file"], {"modules": {"demo": {"status": "success", "merge_dir_files": ["agents/owned.md"]}}})
        self.ctx.update(force=True, explicit_force=False)
        module = {"operations": [{"type": "merge_dir", "source": "source"}]}
        result = installer.execute_module("demo", module, self.ctx)
        self.assertEqual((target / "owned.md").read_text(), "new")
        self.assertEqual((target / "user.md").read_text(), "old")
        self.assertEqual(result["merge_dir_files"], ["agents/owned.md"])

    def test_menu_status_does_not_infer_ownership_from_shared_directory(self):
        (self.root / "hooks").mkdir()
        modules = {"demo": {"operations": [{"type": "copy_dir", "target": "hooks"}]}}
        self.assertFalse(installer.get_installed_modules({"modules": modules}, self.ctx)["demo"])

    @unittest.skipIf(os.name == "nt", "POSIX permissions")
    def test_models_secrets_permissions(self):
        installer.merge_agents_to_models("demo", {"agent": {"model": "m"}}, self.ctx)
        self.assertEqual(self.models.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.models.parent.stat().st_mode & 0o777, 0o700)
        self.models.chmod(0o644)
        installer.unmerge_agents_from_models("demo", self.ctx)
        self.assertEqual(self.models.stat().st_mode & 0o777, 0o600)
