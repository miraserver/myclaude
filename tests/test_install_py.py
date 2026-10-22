"""Installer regression tests; run with unittest and no added dependencies."""

import copy
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
        self.models = self.root / ".codeagent" / "models.json"
        self.hooks = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo ok"}]}]}}

    def write_bom(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8-sig")

    def read_json(self, path):
        return json.loads(path.read_text(encoding="utf-8-sig"))

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


if __name__ == "__main__":
    unittest.main()
