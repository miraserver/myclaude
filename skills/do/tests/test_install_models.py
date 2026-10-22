"""Standalone do installer models requirements (I9), isolated from user state."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("do_installer_models", ROOT / "install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class DoModelsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        for patcher in (mock.patch.object(installer.Path, "home", return_value=self.home),
                        mock.patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home),
                                                    "CLAUDE_PROJECT_DIR": str(self.home)})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.path = self.home / ".codeagent/models.json"

    def test_i9_new_models_contains_do_agents_and_backend_defaults(self):
        template = json.loads((ROOT.parents[1] / "templates/models.json.example").read_text())
        with contextlib.redirect_stdout(io.StringIO()):
            installer.install_models_json()
        actual = json.loads(self.path.read_text())
        for key in ("backends", "default_backend", "default_model"):
            self.assertEqual(actual[key], template[key])
        self.assertEqual(set(actual["agents"]), {"develop", "code-explorer", "code-architect", "code-reviewer"})
        for name, agent in actual["agents"].items():
            # do uses its generic develop prompt rather than omo's prompt_file.
            expected = {k: v for k, v in template["agents"][name].items() if k != "prompt_file"}
            self.assertEqual(agent, {**expected, "__module__": "do"})

    def test_i9_existing_models_only_adds_missing_do_agents(self):
        original = {"default_backend": "custom", "backends": {"custom": {"api_key": "keep"}},
                    "user": ["keep"], "agents": {"develop": {"model": "mine"}, "foreign": {"model": "mine"}}}
        self.path.parent.mkdir()
        self.path.write_text(json.dumps(original))
        with contextlib.redirect_stdout(io.StringIO()):
            installer.install_models_json()
        actual = json.loads(self.path.read_text())
        expected = json.loads(json.dumps(original))
        expected["agents"].update({name: {**cfg, "__module__": "do"} for name, cfg in installer.MODELS_JSON_TEMPLATE["agents"].items()
                                   if name not in expected["agents"]})
        self.assertEqual(actual, expected)
        before = self.path.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            installer.install_models_json()
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_models_are_preserved_with_warning(self):
        self.path.parent.mkdir()
        for content in ("{invalid", "[]", "null", '"text"', "42"):
            with self.subTest(content=content):
                self.path.write_text(content)
                before = self.path.read_bytes()
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    installer.install_models_json()
                self.assertEqual(self.path.read_bytes(), before)
                self.assertIn("Warning", output.getvalue())
                self.assertIn(str(self.path), output.getvalue())

    def test_missing_or_non_object_agents_are_merged(self):
        self.path.parent.mkdir()
        for agents in ("missing", None, [], "bad", 42):
            original = {"custom": "keep"}
            if agents != "missing":
                original["agents"] = agents
            self.path.write_text(json.dumps(original))
            with contextlib.redirect_stdout(io.StringIO()):
                installer.install_models_json()
            actual = json.loads(self.path.read_text())
            self.assertEqual(actual["custom"], "keep")
            self.assertEqual(actual["agents"], {name: {**cfg, "__module__": "do"}
                for name, cfg in installer.MODELS_JSON_TEMPLATE["agents"].items()})
