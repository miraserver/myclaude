"""Regression tests for wrapper cleanup in the Python uninstaller."""

import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("uninstaller_under_test", ROOT / "uninstall.py")
uninstaller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(uninstaller)


class UninstallerWrapperTests(unittest.TestCase):
    def test_copy_file_uninstall_checks_source_bytes(self):
        installer_spec = importlib.util.spec_from_file_location("copy_file_installer", ROOT / "install.py")
        installer = importlib.util.module_from_spec(installer_spec)
        installer_spec.loader.exec_module(installer)
        for scenario in ("identical", "user", "missing", "missing source", "unreadable source"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                install_dir = root / "install"
                source = root / "source.md"
                target = install_dir / "agents/dev-plan-generator.md"
                source.write_bytes(b"\x00\xff\r\n")
                target.parent.mkdir(parents=True)
                op = {"type": "copy_file", "source": "source.md", "target": "agents/dev-plan-generator.md"}
                config = {"modules": {"demo": {"operations": [op]}}}
                ctx = {"install_dir": install_dir, "config_dir": root, "log_file": root / "install.log"}
                output = io.StringIO()
                with mock.patch.dict("os.environ", {"HOME": str(root), "USERPROFILE": str(root)}), \
                        mock.patch.object(uninstaller.Path, "home", return_value=root), \
                        mock.patch.object(uninstaller, "__file__", str(root / "uninstall.py")), \
                        mock.patch.object(uninstaller, "load_config", return_value=config):
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
                    (install_dir / "installed_modules.json").write_text(
                        json.dumps({"modules": {"demo": {"status": "success"}}}), encoding="utf-8")
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(uninstaller.main([
                            "--install-dir", str(install_dir), "--module", "demo", "--yes"
                        ]), 0)
                if scenario == "user":
                    self.assertEqual(target.read_bytes(), b"user agent\n")
                    self.assertIn(f"Keeping {target}: differs from the installed copy", output.getvalue())
                else:
                    self.assertFalse(target.exists())

    def test_windows_wrapper_is_removed_without_touching_sibling_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            install_dir = root / "install"
            profile = root / "profile"
            wrapper_dir = profile / "bin"
            install_dir.mkdir()
            wrapper_dir.mkdir(parents=True)
            wrapper = wrapper_dir / "codeagent-wrapper.exe"
            sibling = wrapper_dir / "user-tool.exe"
            wrapper.write_bytes(b"wrapper")
            sibling.write_bytes(b"keep")
            (install_dir / "installed_modules.json").write_text(
                json.dumps({"modules": {"demo": {"status": "success"}}}),
                encoding="utf-8",
            )
            config = {"modules": {"demo": {"operations": [
                {"type": "run_command", "command": "bash install.sh"}
            ]}}}

            with mock.patch.object(uninstaller.sys, "platform", "win32"), \
                    mock.patch.dict("os.environ", {"HOME": str(root), "USERPROFILE": str(profile)}), \
                    mock.patch.object(uninstaller.Path, "home", return_value=root), \
                    mock.patch.object(uninstaller, "load_config", return_value=config):
                self.assertEqual(uninstaller.main([
                    "--install-dir", str(install_dir), "--module", "demo", "--yes"
                ]), 0)

            self.assertFalse(wrapper.exists())
            self.assertEqual(sibling.read_bytes(), b"keep")
            self.assertTrue(wrapper_dir.is_dir())

    def test_partial_uninstall_keeps_shared_wrapper_then_removes_last_dependency(self):
        for platform in ("win32", "linux", "darwin"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                install_dir = root / "install"
                profile = root / "profile"
                install_dir.mkdir()
                config = {"modules": {
                    name: {"operations": [
                        {"type": "run_command", "command": command},
                        {"type": "copy_file", "target": name + ".txt"},
                    ]} for name, command in (
                        ("first", "bash install.sh"), ("second", "install.bat"),
                        ("other", "echo no-wrapper"),
                    )
                }}
                (install_dir / "installed_modules.json").write_text(
                    json.dumps({"modules": {name: {"status": "success"} for name in config["modules"]}}),
                    encoding="utf-8",
                )
                for name in config["modules"]:
                    (install_dir / (name + ".txt")).write_text(name)
                with mock.patch.object(uninstaller.sys, "platform", platform), \
                        mock.patch.dict("os.environ", {"HOME": str(profile), "USERPROFILE": str(profile)}), \
                        mock.patch.object(uninstaller.Path, "home", return_value=profile), \
                        mock.patch.object(uninstaller, "load_config", return_value=config):
                    wrapper = uninstaller._wrapper_bin_path(install_dir)
                    wrapper.parent.mkdir(parents=True)
                    wrapper.write_bytes(b"wrapper")
                    sibling = wrapper.parent / "user-tool"
                    sibling.write_bytes(b"keep")
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(uninstaller.main([
                            "--install-dir", str(install_dir), "--module", "first", "--yes"
                        ]), 0)
                    self.assertIn("Keeping codeagent-wrapper (still required by: second)", output.getvalue())
                    self.assertEqual(wrapper.read_bytes(), b"wrapper")
                    self.assertEqual(sibling.read_bytes(), b"keep")
                    self.assertTrue((install_dir / "second.txt").exists())
                    self.assertFalse((install_dir / "first.txt").exists())
                    self.assertEqual(uninstaller.main([
                        "--install-dir", str(install_dir), "--module", "second", "--yes"
                    ]), 0)
                    self.assertFalse(wrapper.exists())
                    self.assertEqual(sibling.read_bytes(), b"keep")
                    self.assertTrue((install_dir / "other.txt").exists())
                    remaining = json.loads((install_dir / "installed_modules.json").read_text())
                    self.assertEqual(set(remaining["modules"]), {"other"})

    def test_wrapper_permission_error_warns_and_continues(self):
        for platform in ("win32", "linux"):
            for purge in (False, True):
                with self.subTest(platform=platform, purge=purge), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    install_dir = root / "install"
                    profile = root / "profile"
                    install_dir.mkdir()
                    (install_dir / "installed_modules.json").write_text(
                        json.dumps({"modules": {"demo": {"status": "success"}}}), encoding="utf-8"
                    )
                    config = {"modules": {"demo": {"operations": [
                        {"type": "run_command", "command": "bash install.sh"}
                    ]}}}
                    with mock.patch.object(uninstaller.sys, "platform", platform), \
                            mock.patch.dict("os.environ", {"HOME": str(profile), "USERPROFILE": str(profile)}), \
                            mock.patch.object(uninstaller.Path, "home", return_value=profile), \
                            mock.patch.object(uninstaller, "load_config", return_value=config):
                        wrapper = uninstaller._wrapper_bin_path(install_dir)
                        wrapper.parent.mkdir(parents=True)
                        wrapper.write_bytes(b"wrapper")
                        original_unlink = uninstaller.os.unlink

                        def locked_unlink(path, *args, **kwargs):
                            if Path(path).name == wrapper.name:
                                raise PermissionError("executable is running")
                            return original_unlink(path, *args, **kwargs)

                        errors = io.StringIO()
                        with mock.patch.object(uninstaller.os, "unlink", side_effect=locked_unlink), \
                                contextlib.redirect_stderr(errors):
                            self.assertEqual(uninstaller.main([
                                "--install-dir", str(install_dir), "--yes",
                                *( ["--purge"] if purge else []),
                            ]), 0)
                        self.assertIn("Warning:", errors.getvalue())
                        self.assertIn(str(wrapper), errors.getvalue())
                        self.assertNotIn("Traceback", errors.getvalue())
                        self.assertTrue(wrapper.exists())


class SharedAgentUninstallTests(unittest.TestCase):
    def test_i6_shared_agents_restore_only_from_modules_remaining_installed(self):
        spec = importlib.util.spec_from_file_location("shared_agent_installer", ROOT / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        for selection in ("do,omo", "omo,do", "do"):
            with self.subTest(selection=selection), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config = {"modules": {name: {"operations": [], "agents": {
                    "develop": {"backend": "codex", "model": name}}} for name in ("do", "omo")}}
                config_path = root / "config.json"
                installer._save_json(config_path, config)
                status = root / "installed_modules.json"
                installer._save_json(status, {"modules": {name: {"status": "success"} for name in ("do", "omo")}})
                models_path = root / ".codeagent/models.json"
                agent = {"backend": "codex", "model": "do", "__module__": "do"}
                agent["__hash__"] = installer.agent_defaults_hash(agent)
                installer._save_json(models_path, {"agents": {"develop": agent}})
                with mock.patch.dict("os.environ", {"HOME": str(root), "USERPROFILE": str(root)}), \
                        mock.patch.object(installer.Path, "home", return_value=root), \
                        mock.patch.object(installer, "load_config", return_value=config), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(installer.main(["--config", str(config_path), "--install-dir", str(root),
                                                     "--uninstall", "--module", selection]), 0)
                agents = json.loads(models_path.read_text())["agents"]
                if selection == "do":
                    self.assertEqual(agents["develop"]["__module__"], "omo")
                    self.assertEqual(agents["develop"]["__hash__"], installer.agent_defaults_hash(agents["develop"]))
                else:
                    self.assertEqual(agents, {})


if __name__ == "__main__":
    unittest.main()
