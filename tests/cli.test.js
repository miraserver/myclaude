"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const {
  applyModule,
  upsertModuleStatus,
  loadInstalledStatus,
  readInstalledModuleNamesFromStatus,
  detectInstalledModuleNames,
  installScriptCommand,
  wrapperBinPath,
  resolveInstallDir,
  printPostInstallInfo,
  normalizeHookCommand,
  hookEntryKey,
  entryPointsInto,
  mergeHooksToSettings,
  unmergeHooksFromSettings,
  mergeModuleHooks,
  mergeModuleAgentsToModels,
  agentDefaultsHash,
  uninstallModule,
  parseArgs,
} = require("../bin/cli.js");

const doHooks = require("../skills/do/hooks/hooks.json");
const globalHooks = require("../hooks/hooks.json");
const cliPath = path.resolve(__dirname, "../bin/cli.js");

for (const [platform, cmd, script] of [
  ["win32", "cmd.exe", "install.bat"],
  ["linux", "bash", "install.sh"],
]) {
  test(`installScriptCommand uses an absolute script path for ${platform}`, () => {
    const repoRoot = path.resolve(__dirname, "..");
    const command = installScriptCommand(repoRoot, platform);
    assert.deepEqual(command, {
      cmd,
      args: platform === "win32" ? ["/c", path.join(repoRoot, script)] : [path.join(repoRoot, script)],
    });
    const scriptPath = command.args[command.args.length - 1];
    assert.equal(path.isAbsolute(scriptPath), true);
    assert.equal(path.dirname(scriptPath), repoRoot);
  });
}

test("wrapperBinPath uses the platform-specific wrapper location", () => {
  assert.equal(wrapperBinPath("C:\\install", "win32", "C:\\Users\\tester"),
    path.win32.join("C:\\Users\\tester", "bin", "codeagent-wrapper.exe"));
  for (const platform of ["linux", "darwin"]) {
    assert.equal(wrapperBinPath("/install", platform, "/home/tester"),
      path.join("/install", "bin", "codeagent-wrapper"));
  }
});

test("relative install directory is resolved against the current directory", () => {
  const cwd = path.join(os.tmpdir(), "myclaude-cwd");
  assert.equal(resolveInstallDir("relative/install", cwd), path.resolve(cwd, "relative/install"));
  assert.equal(path.isAbsolute(resolveInstallDir("relative/install", cwd)), true);
});

test("post-install check finds a wrapper at the platform helper path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-wrapper-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldUserProfile = process.env.USERPROFILE;
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.HOME = root;
  if (process.platform === "win32") process.env.USERPROFILE = root;
  const installDir = path.join(root, "install");
  const wrapper = wrapperBinPath(installDir);
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  if (process.platform === "win32") fs.copyFileSync(process.execPath, wrapper);
  else {
    fs.writeFileSync(wrapper, "#!/bin/sh\necho test-wrapper 1.0\n");
    fs.chmodSync(wrapper, 0o755);
  }
  process.env.PATH = path.dirname(wrapper);
  t.after(() => {
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    process.env.PATH = oldPath;
  });
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = (value) => { output += value; return true; };
  try { printPostInstallInfo(installDir); }
  finally { process.stdout.write = write; }
  assert.match(output, /codeagent-wrapper: (test-wrapper 1\.0|v\d+\.\d+\.\d+)/);
  assert.match(output, /PATH: .* ✓/);
});

test("post-install PATH comparison handles Windows casing and Unix realpath fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-path-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of ["win32", "linux"]) {
    for (const realpathFails of [false, true]) {
      const pathApi = platform === "win32" ? path.win32 : path.posix;
      const home = platform === "win32" ? "C:\\Temp\\Profile"
        : root.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
      const installDir = pathApi.join(home, "install");
      const binDir = platform === "win32" ? pathApi.join(home, "bin") : pathApi.join(installDir, "bin");
      let output = "";
      let realpathCalls = 0;
      const sandbox = {
        module: { exports: {} },
        require: (name) => {
          if (name === "path") return pathApi;
          if (name === "os") return { homedir: () => home };
          if (name === "fs") return { realpathSync: (value) => {
            realpathCalls++;
            if (realpathFails) throw new Error("path missing");
            return value === "/alias" ? binDir : value;
          } };
          if (name === "child_process") return { spawnSync: () => ({ status: 1 }) };
          return require(name);
        },
        process: {
          platform,
          env: { HOME: root, USERPROFILE: root, PATH: platform === "win32"
            ? binDir.toUpperCase() + "\\." : realpathFails ? binDir : "/alias" },
          stdout: { write: (value) => { output += value; } },
        },
      };
      vm.runInNewContext(fs.readFileSync(cliPath, "utf8"), sandbox);
      sandbox.module.exports.printPostInstallInfo(installDir);
      assert.match(output, /PATH: .* ✓/, `${platform}, realpathFails=${realpathFails}`);
      assert.equal(realpathCalls, platform === "win32" ? 0 : realpathFails ? 1 : 2);
    }
  }
});

test("offline wrapper install skips the installer process", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-offline-wrapper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let output = "";
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "child_process" ? {
      spawn: () => { throw new Error("offline mode must not spawn installer"); },
      spawnSync,
    } : require(name),
    process: { platform: process.platform, env: { ...process.env }, stdout: { write: (s) => { output += s; } } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") +
    "\nmodule.exports.testRunInstallSh = runInstallSh;\n", sandbox);
  await sandbox.module.exports.testRunInstallSh(root, path.join(root, "install"), null, true);
  assert.equal(output, "Offline mode: skipping codeagent-wrapper download.\n");
});

test("offline install selection continues without spawning the wrapper installer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-offline-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let output = "";
  const sandbox = {
    module: { exports: {} },
    __dirname: path.dirname(cliPath),
    require: (name) => name === "child_process" ? {
      spawn: () => { throw new Error("offline mode must not spawn installer"); },
      spawnSync,
    } : require(name),
    process: { platform: process.platform, env: { ...process.env }, stdout: { write: (s) => { output += s; } } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") +
    "\nmodule.exports.testInstallSelected = installSelected;\n", sandbox);
  const installDir = path.join(root, "install");
  await sandbox.module.exports.testInstallSelected(
    [{ kind: "wrapper", id: "codeagent-wrapper" }], null, {}, installDir, false, false, true
  );
  assert.match(output, /Offline mode: skipping codeagent-wrapper download\./);
  assert.equal(fs.existsSync(path.join(installDir, "bin", "codeagent-wrapper")), false);
});

test("offline CLI update skips wrapper process without --skip-wrapper", (t) => {
  const f = fixture(t);
  upsertModuleStatus(f.installDir, { module: "do" });
  const env = { ...process.env };
  delete env.MYCLAUDE_SKIP_WRAPPER;
  const result = spawnSync(process.execPath, [cliPath, "--update", "--offline",
    "--install-dir", f.installDir], { encoding: "utf8", timeout: 10000, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Offline mode: skipping codeagent-wrapper download\./);
  assert.equal(fs.existsSync(path.join(f.installDir, "bin", "codeagent-wrapper")), false);
});

test("install.bat builds latest and tagged release URLs", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../install.bat"), "utf8");
  assert.doesNotMatch(source, /releases\/%VERSION%\/download/);
  assert.match(source, /releases\/latest\/download\/%BINARY_NAME%/);
  assert.match(source, /releases\/download\/%VERSION%\/%BINARY_NAME%/);
});

test("Windows installer runs with current-directory executable lookup disabled", {
  skip: process.platform !== "win32",
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "install.bat"), "@echo off\r\nexit /b 0\r\n");
  const { cmd, args } = installScriptCommand(dir);
  const result = spawnSync(cmd, args, {
    cwd: dir,
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr?.toString());
});

function fixture(t, settings = {}) {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-cli-"));
  const settingsPath = path.join(installDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings) + "\n");
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const previous = process.env.MYCLAUDE_PYTHON;
  process.env.MYCLAUDE_PYTHON = "python3";
  t.after(() => {
    if (previous === undefined) delete process.env.MYCLAUDE_PYTHON;
    else process.env.MYCLAUDE_PYTHON = previous;
  });
  return {
    installDir,
    settingsPath,
    root: path.join(installDir, "skills", "do").replace(/\\/g, "/"),
    read: () => JSON.parse(fs.readFileSync(settingsPath, "utf8")),
  };
}

function commandEntry(command, extra = {}) {
  return { hooks: [{ type: "command", command, timeout: 1800 }], ...extra };
}

function modelsFixture(t, agents) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-models-"));
  for (const name of ["USERPROFILE", "HOME"]) {
    const previous = process.env[name];
    process.env[name] = homeDir;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  assert.equal(os.homedir(), homeDir);
  const modelsPath = path.join(homeDir, ".codeagent", "models.json");
  if (agents !== undefined) {
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify({ agents }, null, 2) + "\n");
  }
  return {
    modelsPath,
    merge: (cfg) => mergeModuleAgentsToModels("do", { agents: { "code-reviewer": cfg } }, homeDir),
    read: () => JSON.parse(fs.readFileSync(modelsPath, "utf8")),
  };
}

test("agent defaults hash sorts keys recursively and ignores install metadata", () => {
  const cfg = { reasoning: "high", options: { z: [{ b: 2, a: 1 }], a: true }, model: "gpt-6.1-sol" };
  const canonical = '{"model":"gpt-6.1-sol","options":{"a":true,"z":[{"a":1,"b":2}]},"reasoning":"high"}';
  const expected = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  assert.equal(agentDefaultsHash(cfg), expected);
  assert.equal(agentDefaultsHash({ ...cfg, __module__: "do", __hash__: "ignored" }), expected);
  assert.notEqual(agentDefaultsHash({ ...cfg, options: { a: true, z: [{ a: 2, b: 1 }] } }), expected);
});

test("fresh agent merge writes module and defaults hash", (t) => {
  const f = modelsFixture(t);
  const cfg = { model: "gpt-6.1-sol", reasoning: "high" };
  assert.equal(f.merge(cfg), true);
  assert.deepEqual(f.read().agents["code-reviewer"], {
    ...cfg, __module__: "do", __hash__: agentDefaultsHash(cfg),
  });
  assert.equal(fs.readFileSync(f.modelsPath, "utf8"), JSON.stringify(f.read(), null, 2) + "\n");
});

test("unchanged agent re-merge does not write models.json", (t) => {
  const f = modelsFixture(t);
  const cfg = { model: "gpt-6.1-sol", reasoning: "high" };
  assert.equal(f.merge(cfg), true);
  const bytes = fs.readFileSync(f.modelsPath, "utf8");
  const oldTime = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(f.modelsPath, oldTime, oldTime);
  const mtime = fs.statSync(f.modelsPath).mtimeMs;
  assert.equal(f.merge(cfg), false);
  assert.equal(fs.readFileSync(f.modelsPath, "utf8"), bytes);
  assert.equal(fs.statSync(f.modelsPath).mtimeMs, mtime);
});

test("unedited hashed agent gets new module defaults", (t) => {
  const old = { model: "old-model", reasoning: "high" };
  const f = modelsFixture(t, {
    "code-reviewer": { ...old, __module__: "do", __hash__: agentDefaultsHash(old) },
  });
  const cfg = { model: "gpt-6.1-sol", reasoning: "medium" };
  assert.equal(f.merge(cfg), true);
  assert.deepEqual(f.read().agents["code-reviewer"], {
    ...cfg, __module__: "do", __hash__: agentDefaultsHash(cfg),
  });
});

test("user-edited hashed agent is preserved", (t) => {
  const old = { model: "gpt-6.1-sol", reasoning: "medium" };
  const edited = { ...old, model: "gpt-6-astra", __module__: "do", __hash__: agentDefaultsHash(old) };
  const f = modelsFixture(t, { "code-reviewer": edited });
  const bytes = fs.readFileSync(f.modelsPath, "utf8");
  assert.equal(f.merge({ model: "new-model", reasoning: "high" }), false);
  assert.deepEqual(f.read().agents["code-reviewer"], edited);
  assert.equal(fs.readFileSync(f.modelsPath, "utf8"), bytes);
});

test("legacy module agent without a hash is overwritten", (t) => {
  const f = modelsFixture(t, { "code-reviewer": { model: "old-model", __module__: "do" } });
  const cfg = { model: "gpt-6.1-sol", reasoning: "high" };
  assert.equal(f.merge(cfg), true);
  assert.deepEqual(f.read().agents["code-reviewer"], {
    ...cfg, __module__: "do", __hash__: agentDefaultsHash(cfg),
  });
});

test("agent without module ownership is untouched", (t) => {
  const cfg = { model: "gpt-6-astra", reasoning: "medium" };
  const f = modelsFixture(t, { "code-reviewer": cfg });
  const bytes = fs.readFileSync(f.modelsPath, "utf8");
  assert.equal(f.merge({ model: "gpt-6.1-sol" }), false);
  assert.equal(fs.readFileSync(f.modelsPath, "utf8"), bytes);
});

test("reordered agent keys still count as unedited", (t) => {
  const old = { model: "old-model", options: { a: 1, z: [{ a: true, b: false }] } };
  const f = modelsFixture(t, { "code-reviewer": {
    __hash__: agentDefaultsHash(old), __module__: "do",
    options: { z: [{ b: false, a: true }], a: 1 }, model: "old-model",
  } });
  assert.equal(f.merge(old), false);
  const cfg = { model: "gpt-6.1-sol" };
  assert.equal(f.merge(cfg), true);
  assert.deepEqual(f.read().agents["code-reviewer"], {
    ...cfg, __module__: "do", __hash__: agentDefaultsHash(cfg),
  });
});

for (const existing of [null, false, "invalid", 42, []]) {
  test("non-object agent " + JSON.stringify(existing) + " is replaced", (t) => {
    const f = modelsFixture(t, { "code-reviewer": existing });
    const cfg = { model: "gpt-6.1-sol" };
    assert.equal(f.merge(cfg), true);
    assert.deepEqual(f.read().agents["code-reviewer"], {
      ...cfg, __module__: "do", __hash__: agentDefaultsHash(cfg),
    });
  });
}

function foreignHooks() {
  return [
    commandEntry("if [ -f 'C:/Users/user/.orca/agent-hooks/claude-hook.cmd' ]; then run; fi"),
    commandEntry('powershell -File "C:\\Users\\user\\herdr\\hook.ps1"'),
  ];
}

test("fresh merge marks entries and preserves quoted posix paths", (t) => {
  const f = fixture(t);
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), true);
  assert.deepEqual(f.read().hooks.Stop, [
    commandEntry('python3 "' + f.root + '/hooks/stop-hook.py"', { __module__: "do" }),
  ]);
});

test("re-merge is idempotent and does not save settings", (t) => {
  const f = fixture(t);
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), true);
  const bytes = fs.readFileSync(f.settingsPath, "utf8");
  const oldTime = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(f.settingsPath, oldTime, oldTime);
  const mtime = fs.statSync(f.settingsPath).mtimeMs;
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), false);
  assert.equal(fs.readFileSync(f.settingsPath, "utf8"), bytes);
  assert.equal(fs.statSync(f.settingsPath).mtimeMs, mtime);
  assert.equal(f.read().hooks.Stop.length, 1);
});

test("re-merge removes obsolete owned hook types", (t) => {
  const f = fixture(t, {
    hooks: { SubagentStop: [commandEntry("python3 verify-loop.py", { __module__: "do" })] },
  });
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), true);
  assert.equal(f.read().hooks.SubagentStop, undefined);
  assert.equal(f.read().hooks.Stop.length, 1);
  assert.equal(mergeHooksToSettings("do", { hooks: {} }, f.installDir, f.root), true);
  assert.deepEqual(f.read().hooks, {});
});

test("unmarked orphan is replaced by exactly one marked Stop entry", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.settingsPath, JSON.stringify({
    hooks: { Stop: [commandEntry('python3 "' + f.root + '/hooks/stop-hook.py"')] },
  }));
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), true);
  assert.equal(f.read().hooks.Stop.length, 1);
  assert.equal(f.read().hooks.Stop[0].__module__, "do");
});

test("orphans with backslashes, different quoting and interpreters are recognized", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.settingsPath, JSON.stringify({
    hooks: {
      Stop: [
        commandEntry("python '" + f.root.replace(/\//g, "\\").toUpperCase() + "\\hooks\\stop-hook.py'"),
        commandEntry('py -3 "' + f.root + '/hooks/stop-hook.py"'),
      ],
      SubagentStop: [commandEntry('python "' + f.root + '/hooks/verify-loop.py"')],
    },
  }));
  mergeHooksToSettings("do", doHooks, f.installDir, f.root);
  assert.equal(f.read().hooks.Stop.length, 1);
  assert.equal(f.read().hooks.Stop[0].__module__, "do");
  assert.equal(f.read().hooks.SubagentStop, undefined);
});

test("foreign hooks remain untouched and retain their order", (t) => {
  const foreign = foreignHooks();
  const f = fixture(t, { hooks: { Stop: foreign }, permissions: { allow: ["Read"] } });
  mergeHooksToSettings("do", doHooks, f.installDir, f.root);
  assert.deepEqual(f.read().hooks.Stop.slice(0, 2), foreign);
  assert.deepEqual(f.read().permissions, { allow: ["Read"] });
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), false);
  assert.deepEqual(f.read().hooks.Stop.slice(0, 2), foreign);
});

test("cross-module merge deduplicates the shared do hooks", (t) => {
  const f = fixture(t);
  mergeHooksToSettings("do", doHooks, f.installDir, f.root);
  assert.equal(mergeHooksToSettings("claudekit", doHooks, f.installDir, f.root), false);
  assert.equal(f.read().hooks.Stop.length, 1);
  assert.equal(f.read().hooks.Stop[0].__module__, "do");
});

test("same-key foreign entries are deduplicated without changing their metadata", (t) => {
  const existing = commandEntry("python 'C:\\Shared\\hook.py'", { matcher: "Bash", __module__: "other" });
  existing.hooks[0].timeout = 42;
  const f = fixture(t, { hooks: { PreToolUse: [existing] } });
  const config = { hooks: { PreToolUse: [commandEntry('python3 "c:/shared/hook.py"', { matcher: "Bash" })] } };
  assert.equal(mergeHooksToSettings("do", config, f.installDir), false);
  assert.deepEqual(f.read().hooks.PreToolUse, [existing]);
});

test("unmerge removes owned hooks and orphans in all supplied roots, retaining foreign hooks", (t) => {
  const f = fixture(t);
  const foreign = foreignHooks();
  const other = commandEntry('python "' + f.root + '/hooks/shared.py"', { __module__: "other" });
  const secondRoot = path.join(f.installDir, "hooks").replace(/\\/g, "/");
  fs.writeFileSync(f.settingsPath, JSON.stringify({
    hooks: {
      Stop: [
        foreign[0],
        commandEntry("python3 old.py", { __module__: "do" }),
        commandEntry("python '" + f.root.replace(/\//g, "\\") + "\\hooks\\stop-hook.py'"),
        foreign[1],
        other,
        commandEntry('python3 "' + f.root + '-other/keep.py"'),
      ],
      PreToolUse: [commandEntry('python3 "' + secondRoot + '/pre-bash.py"')],
    },
  }));
  assert.equal(unmergeHooksFromSettings("do", f.installDir, [f.root, secondRoot]), true);
  assert.deepEqual(f.read().hooks.Stop, [
    ...foreign, other, commandEntry('python3 "' + f.root + '-other/keep.py"'),
  ]);
  assert.equal(f.read().hooks.PreToolUse, undefined);
  assert.equal(unmergeHooksFromSettings("do", f.installDir, [f.root, secondRoot]), false);
});

test("python override rewrites python3 commands and leaves other commands alone", (t) => {
  const f = fixture(t);
  process.env.MYCLAUDE_PYTHON = "python";
  const config = { hooks: { Stop: [
    commandEntry('python3 "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.py"'),
    commandEntry("node helper.js"),
    commandEntry("python3-helper script.py"),
  ] } };
  mergeHooksToSettings("do", config, f.installDir, f.root);
  assert.deepEqual(f.read().hooks.Stop.map((entry) => entry.hooks[0].command), [
    'python "' + f.root + '/hooks/stop-hook.py"', "node helper.js", "python3-helper script.py",
  ]);
  assert.equal(config.hooks.Stop[0].hooks[0].command.startsWith("python3 "), true);
  process.env.MYCLAUDE_PYTHON = "py -3";
  assert.equal(mergeHooksToSettings("do", config, f.installDir, f.root), true);
  assert.equal(f.read().hooks.Stop[0].hooks[0].command.startsWith("py -3 "), true);
});

test("command identity ignores interpreter, quotes, slashes, case and hook metadata", (t) => {
  fixture(t);
  assert.equal(normalizeHookCommand('  PY -3  "C:\\Skill Dir\\hook.py"  '), "c:/skill dir/hook.py");
  assert.equal(normalizeHookCommand("python python3 helper.py"), "python3 helper.py");
  assert.equal(hookEntryKey(commandEntry("python3 'C:/Root/h.py'")),
    hookEntryKey({ matcher: "", hooks: [{ command: 'python "c:\\root\\h.py"' }], __module__: "other" }));
  assert.notEqual(hookEntryKey(commandEntry("python h.py", { matcher: "Bash" })),
    hookEntryKey(commandEntry("python h.py", { matcher: "Read" })));
  assert.equal(entryPointsInto(commandEntry("python 'C:\\Root\\h.py'"), ["c:/root/"]), true);
  assert.equal(entryPointsInto(commandEntry("python c:/root-other/h.py"), ["c:/root"]), false);
});

test("parseArgs supports sandbox flags and rejects unknown args", (t) => {
  fixture(t);
  const args = parseArgs(["--offline", "--skip-wrapper", "--tag", "v1", "-y"]);
  assert.equal(args.offline, true);
  assert.equal(args.skipWrapper, true);
  assert.equal(args.tag, "v1");
  assert.equal(args.yes, true);
  assert.equal(parseArgs([]).offline, false);
  assert.equal(parseArgs([]).skipWrapper, false);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown arg/);
});

for (const state of ["missing", "without hooks"]) {
  test("merge handles " + state + " settings.json", (t) => {
    const f = fixture(t, { permissions: { allow: ["Read"] } });
    if (state === "missing") fs.unlinkSync(f.settingsPath);
    assert.equal(unmergeHooksFromSettings("do", f.installDir, [f.root]), false);
    assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), true);
    assert.equal(f.read().hooks.Stop.length, 1);
    if (state === "without hooks") assert.deepEqual(f.read().permissions, { allow: ["Read"] });
  });
}

test("module merge reconciles all hook sources together", (t) => {
  const f = fixture(t);
  const mod = { operations: [
    { type: "copy_dir", target: "skills/do" },
    { type: "copy_dir", target: "hooks" },
  ] };
  for (const [target, config] of [["skills/do", doHooks], ["hooks", globalHooks]]) {
    const dir = path.join(f.installDir, target, "hooks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(config));
  }
  assert.equal(mergeModuleHooks("claudekit", mod, f.installDir), true);
  assert.deepEqual(Object.keys(f.read().hooks), ["Stop", "PreToolUse", "UserPromptSubmit"]);
  assert.equal(mergeModuleHooks("claudekit", mod, f.installDir), false);
});

test("uninstall copy_dir preserves foreign files and hooks in shared target", async (t) => {
  const f = fixture(t);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-repo-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "hooks", "module.py"), "module");
  fs.mkdirSync(path.join(f.installDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(f.installDir, "hooks", "module.py"), "module");
  fs.writeFileSync(path.join(f.installDir, "hooks", "herdr-agent-state.ps1"), "foreign");
  fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks: { SessionStart: [
    commandEntry(`powershell -File "${path.join(f.installDir, "hooks", "herdr-agent-state.ps1")}" session`),
  ] } }));
  await uninstallModule("claudekit", { modules: { claudekit: { operations: [
    { type: "copy_dir", source: "hooks", target: "hooks" },
  ] } } }, repoRoot, f.installDir, false);
  assert.equal(fs.existsSync(path.join(f.installDir, "hooks", "module.py")), false);
  assert.equal(fs.existsSync(path.join(f.installDir, "hooks", "herdr-agent-state.ps1")), true);
  assert.equal(f.read().hooks.SessionStart.length, 1);
});

test("uninstall skill dir removes files, empty dirs, and hooks", async (t) => {
  const f = fixture(t);
  const skillRoot = path.join(f.installDir, "skills", "skill").replace(/\\/g, "/");
  fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks: { Stop: [
    commandEntry("python3 /tmp/skill/hooks/stop.py", { __module__: "skill" }),
    commandEntry(`python3 "${skillRoot}/hooks/orphan.py"`),
  ] } }));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-repo-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, "skill", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "skill", "hooks", "hooks.json"), "{}");
  fs.writeFileSync(path.join(repoRoot, "skill", "hooks", "stop.py"), "stop");
  const target = path.join(f.installDir, "skills", "skill");
  fs.mkdirSync(path.join(target, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(target, "hooks", "hooks.json"), "{}");
  fs.writeFileSync(path.join(target, "hooks", "stop.py"), "stop");
  await uninstallModule("skill", { modules: { skill: { operations: [
    { type: "copy_dir", source: "skill", target: "skills/skill" },
  ] } } }, repoRoot, f.installDir, false);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(f.read().hooks, {});
});

test("uninstall missing copy_dir source removes whole target and dry-run changes nothing", async (t) => {
  const f = fixture(t);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-repo-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const target = path.join(f.installDir, "missing");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "file.txt"), "x");
  const config = { modules: { missing: { operations: [
    { type: "copy_dir", source: "absent", target: "missing" },
  ] } } };
  await uninstallModule("missing", config, repoRoot, f.installDir, true);
  assert.equal(fs.existsSync(target), true);
  await uninstallModule("missing", config, repoRoot, f.installDir, false);
  assert.equal(fs.existsSync(target), false);
});

test("offline listing makes no HTTPS requests", (t) => {
  const f = fixture(t);
  const guard = path.join(f.installDir, "no-network.cjs");
  fs.writeFileSync(guard, 'require("https").get = () => { process.stderr.write("NETWORK ATTEMPT"); process.exit(99); };\n');
  const result = spawnSync(process.execPath, ["--require", guard, cliPath, "--list", "--offline"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /module:do/);
  assert.match(result.stdout, /module:claudekit/);
  assert.equal(result.stderr, "");
});

test("Windows Python probing skips broken interpreters and caches the result", (t) => {
  fixture(t);
  const calls = [];
  let warnings = "";
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "child_process" ? {
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: cmd === "py" ? 0 : 9009 };
      },
    } : require(name),
    process: { platform: "win32", env: {}, stderr: { write: (s) => { warnings += s; } } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8"), sandbox);
  assert.equal(sandbox.module.exports.resolvePythonCommand(), "py -3");
  assert.equal(sandbox.module.exports.resolvePythonCommand(), "py -3");
  assert.deepEqual(calls.map((call) => call.cmd), ["python3", "python", "py"]);
  assert.equal(JSON.stringify(calls[2].args), JSON.stringify(["-3", "-c", "import sys"]));
  assert.equal(calls[2].options.windowsHide, true);
  assert.equal(calls[2].options.stdio, "ignore");
  assert.equal(calls[2].options.timeout, 10000);
  assert.equal(warnings, "");

  calls.length = 0;
  sandbox.require = (name) => name === "child_process" ? {
    spawnSync: () => { calls.push(1); return { status: null }; },
  } : require(name);
  const fallbackSandbox = { ...sandbox, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8"), fallbackSandbox);
  assert.equal(fallbackSandbox.module.exports.resolvePythonCommand(), "python3");
  assert.equal(fallbackSandbox.module.exports.resolvePythonCommand(), "python3");
  assert.equal(calls.length, 3);
  assert.equal(warnings.trim().split("\n").length, 1);
  assert.match(warnings, /Warning/);
});

test("wrapper bypass resolves without spawning for both CLI flag and environment", async (t) => {
  fixture(t);
  for (const useFlag of [false, true]) {
    let output = "";
    const sandbox = {
      module: { exports: {} },
      require: (name) => name === "child_process" ? {
        spawn: () => { throw new Error("Wrapper must not spawn"); },
      } : require(name),
      process: {
        argv: ["node", cliPath, ...(useFlag ? ["--skip-wrapper"] : []), "--help"],
        env: useFlag ? {} : { MYCLAUDE_SKIP_WRAPPER: "1" },
        stdout: { write: (s) => { output += s; } },
      },
    };
    vm.runInNewContext(fs.readFileSync(cliPath, "utf8") +
      "\nmodule.exports.testMain = main; module.exports.testRunInstallSh = runInstallSh;\n", sandbox);
    await sandbox.module.exports.testMain();
    output = "";
    await sandbox.module.exports.testRunInstallSh("unused", "unused", null);
    assert.equal(output, "Skipping codeagent-wrapper install.\n");
  }
});


test("BOM settings preserve other keys after hook merge", (t) => {
  const settings = { permissions: { allow: ["Read"] }, theme: "dark" };
  const f = fixture(t, settings);
  fs.writeFileSync(f.settingsPath, "\uFEFF" + JSON.stringify(settings));
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), true);
  assert.deepEqual(f.read().permissions, settings.permissions);
  assert.equal(f.read().theme, settings.theme);
  assert.equal(f.read().hooks.Stop.length, 1);
});

function invalidJsonError(filePath, content) {
  let parseError;
  try { JSON.parse(content); } catch (err) { parseError = err.message; }
  return (err) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes(filePath), err.message);
    assert.ok(err.message.includes(parseError), err.message);
    return true;
  };
}

for (const content of ["", "{invalid", "\uFEFF{invalid"]) {
  test("invalid settings throw without changing bytes: " + JSON.stringify(content), (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.settingsPath, content);
    const bytes = fs.readFileSync(f.settingsPath);
    const check = invalidJsonError(f.settingsPath, content.replace(/^\uFEFF/, ""));
    assert.throws(() => mergeHooksToSettings("do", doHooks, f.installDir, f.root), check);
    assert.throws(() => unmergeHooksFromSettings("do", f.installDir), check);
    assert.deepEqual(fs.readFileSync(f.settingsPath), bytes);
  });
}

test("invalid installed status aborts readers, install, and CLI update without changing bytes", async (t) => {
  const f = fixture(t);
  const statusPath = path.join(f.installDir, "installed_modules.json");
  fs.writeFileSync(statusPath, "{invalid");
  const bytes = fs.readFileSync(statusPath);
  const check = invalidJsonError(statusPath, "{invalid");
  assert.throws(() => loadInstalledStatus(f.installDir), check);
  assert.throws(() => readInstalledModuleNamesFromStatus(f.installDir), check);
  await assert.rejects(applyModule("test", { modules: { test: { operations: [] } } },
    f.installDir, f.installDir, false), check);
  const result = spawnSync(process.execPath, [cliPath, "--update", "--offline", "--skip-wrapper",
    "--install-dir", f.installDir], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(statusPath), result.stderr);
  assert.deepEqual(fs.readFileSync(statusPath), bytes);
});

test("BOM installed status is parsed and other status keys are preserved", (t) => {
  const f = fixture(t);
  const statusPath = path.join(f.installDir, "installed_modules.json");
  fs.writeFileSync(statusPath, "\uFEFF" + JSON.stringify({ custom: true, modules: { essentials: { module: "essentials" } } }));
  assert.deepEqual(readInstalledModuleNamesFromStatus(f.installDir), ["essentials"]);
  upsertModuleStatus(f.installDir, { module: "bmad" });
  assert.equal(loadInstalledStatus(f.installDir).custom, true);
  assert.deepEqual(readInstalledModuleNamesFromStatus(f.installDir), ["bmad", "essentials"]);
});

test("invalid models abort agent merge and module install without changing bytes", async (t) => {
  const f = modelsFixture(t, {});
  fs.writeFileSync(f.modelsPath, "\uFEFF{invalid");
  const bytes = fs.readFileSync(f.modelsPath);
  const check = invalidJsonError(f.modelsPath, "{invalid");
  assert.throws(() => f.merge({ model: "new-model" }), check);
  const dir = path.dirname(f.modelsPath);
  await assert.rejects(applyModule("test", { modules: { test: {
    agents: { oracle: { model: "new-model" } }, operations: [],
  } } }, dir, dir, false), check);
  upsertModuleStatus(dir, { module: "omo" });
  const result = spawnSync(process.execPath, [cliPath, "--update", "--offline", "--skip-wrapper",
    "--install-dir", dir], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(f.modelsPath), result.stderr);
  assert.deepEqual(fs.readFileSync(f.modelsPath), bytes);
});

test("BOM models preserve other keys during agent merge", (t) => {
  const f = modelsFixture(t, {});
  fs.writeFileSync(f.modelsPath, "\uFEFF" + JSON.stringify({ agents: {}, custom: "keep" }));
  assert.equal(f.merge({ model: "new-model" }), true);
  assert.equal(f.read().custom, "keep");
});

test("invalid settings abort module install with the file unchanged", async (t) => {
  const f = fixture(t);
  const hookDir = path.join(f.installDir, "source", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "hooks.json"), JSON.stringify(doHooks));
  fs.writeFileSync(f.settingsPath, "{invalid");
  const bytes = fs.readFileSync(f.settingsPath);
  await assert.rejects(applyModule("test", { modules: { test: { operations: [
    { type: "copy_dir", source: "source", target: "skills/test" },
  ] } } }, f.installDir, f.installDir, false), invalidJsonError(f.settingsPath, "{invalid"));
  assert.equal(fs.existsSync(path.join(f.installDir, "skills/test")), false);
  upsertModuleStatus(f.installDir, { module: "do" });
  const result = spawnSync(process.execPath, [cliPath, "--update", "--offline", "--skip-wrapper",
    "--install-dir", f.installDir], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(f.settingsPath), result.stderr);
  assert.deepEqual(fs.readFileSync(f.settingsPath), bytes);
  assert.equal(fs.existsSync(path.join(f.installDir, "skills/do")), false);
});

function runUpdate(installDir, ...args) {
  const result = spawnSync(process.execPath, [cliPath, "--update", "--offline", "--skip-wrapper",
    "--install-dir", installDir, ...args], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

for (const explicitForce of [false, true]) {
  test("CLI update protects foreign merge files unless explicitly forced: " + explicitForce, async (t) => {
    const f = fixture(t);
    const repoRoot = path.resolve(__dirname, "..");
    const config = require("../config.json");
    const target = path.join(f.installDir, "commands", "review.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "my personal review command");
    upsertModuleStatus(f.installDir, { module: "essentials", merge_dir_files: [] });
    const result = runUpdate(f.installDir, ...(explicitForce ? ["--force"] : []));
    const recorded = loadInstalledStatus(f.installDir).modules.essentials.merge_dir_files;
    if (explicitForce) {
      assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(repoRoot, "agents/development-essentials/commands/review.md")));
      assert.ok(recorded.includes("commands/review.md"));
    } else {
      assert.equal(fs.readFileSync(target, "utf8"), "my personal review command");
      assert.equal(recorded.includes("commands/review.md"), false);
      assert.ok(result.stdout.includes(`skipped ${target}: exists and is not owned by essentials (use --force to overwrite)\n`), result.stdout);
      await uninstallModule("essentials", config, repoRoot, f.installDir, false);
      assert.equal(fs.readFileSync(target, "utf8"), "my personal review command");
    }
  });
}

test("owned merge file is overwritten by CLI update", (t) => {
  const f = fixture(t);
  const target = path.join(f.installDir, "commands", "review.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "old owned version");
  upsertModuleStatus(f.installDir, { module: "essentials", merge_dir_files: ["commands/review.md"] });
  runUpdate(f.installDir);
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.resolve(__dirname, "../agents/development-essentials/commands/review.md")));
  assert.ok(loadInstalledStatus(f.installDir).modules.essentials.merge_dir_files.includes("commands/review.md"));
});

test("reinstall without force retains existing ownership including retired source files", async (t) => {
  const f = fixture(t);
  const repoRoot = path.join(f.installDir, "source");
  const source = path.join(repoRoot, "module", "commands");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "review.md"), "original");
  const config = { modules: { test: { operations: [{ type: "merge_dir", source: "module" }] } } };
  const install = () => applyModule("test", config, repoRoot, f.installDir, false);
  upsertModuleStatus(f.installDir, await install());
  const commands = path.join(f.installDir, "commands");
  fs.writeFileSync(path.join(commands, "retired.md"), "previously owned");
  upsertModuleStatus(f.installDir, { module: "test", merge_dir_files: ["commands/review.md", "commands/retired.md", "commands/deleted.md"] });
  fs.writeFileSync(path.join(source, "review.md"), "new version");
  const result = await install();
  assert.deepEqual(result.merge_dir_files.sort(), ["commands/retired.md", "commands/review.md"]);
  upsertModuleStatus(f.installDir, result);
  assert.equal(fs.readFileSync(path.join(commands, "review.md"), "utf8"), "original");
  await uninstallModule("test", config, repoRoot, f.installDir, false);
  assert.equal(fs.existsSync(commands), false);
});

test("identical unowned merge files become owned on update", (t) => {
  const f = fixture(t);
  const target = path.join(f.installDir, "commands", "review.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, "../agents/development-essentials/commands/review.md"), target);
  upsertModuleStatus(f.installDir, { module: "essentials", merge_dir_files: [] });
  runUpdate(f.installDir);
  assert.ok(loadInstalledStatus(f.installDir).modules.essentials.merge_dir_files.includes("commands/review.md"));
});

test("legacy detection finds differing merge files but update preserves user ownership", async (t) => {
  const f = fixture(t);
  const repoRoot = path.resolve(__dirname, "..");
  const config = require("../config.json");
  fs.mkdirSync(path.join(f.installDir, "hooks"));
  fs.writeFileSync(path.join(f.installDir, "hooks", "foreign.py"), "foreign");
  fs.mkdirSync(path.join(f.installDir, "commands"));
  const review = path.join(f.installDir, "commands", "review.md");
  fs.writeFileSync(review, "personal command");
  const detected = await detectInstalledModuleNames(config, repoRoot, f.installDir);
  assert.equal(detected.includes("claudekit"), false);
  assert.equal(detected.includes("essentials"), true);
  runUpdate(f.installDir);
  assert.equal(fs.readFileSync(review, "utf8"), "personal command");
  assert.equal(loadInstalledStatus(f.installDir).modules.essentials.merge_dir_files.includes("commands/review.md"), false);
});

test("agent prompt files match their module install targets and existing sources", () => {
  const config = require("../config.json");
  const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../templates/models.json.example"), "utf8"));
  for (const mod of Object.values(config.modules)) {
    for (const agent of Object.values(mod.agents || {})) {
      if (!agent.prompt_file) continue;
      const op = mod.operations.find((op) =>
        (op.type === "copy_file" && agent.prompt_file === "~/.claude/" + op.target) ||
        (op.type === "copy_dir" && agent.prompt_file.startsWith("~/.claude/" + op.target + "/")));
      assert.ok(op, agent.prompt_file);
      const suffix = agent.prompt_file.slice(("~/.claude/" + op.target).length);
      assert.ok(fs.statSync(path.resolve(__dirname, "..", op.source + suffix)).isFile(), agent.prompt_file);
    }
  }
  for (const [name, agent] of Object.entries(config.modules.omo.agents)) {
    assert.equal(agent.prompt_file, `~/.claude/skills/omo/references/${name}.md`);
    assert.equal(template.agents[name].prompt_file, agent.prompt_file);
  }
});

test("omo old defaults hash refreshes prompts while edited and unmarked entries are preserved", (t) => {
  const mod = require("../config.json").modules.omo;
  const agents = {};
  for (const [name, cfg] of Object.entries(mod.agents)) {
    const { prompt_file, ...old } = cfg;
    agents[name] = { ...old, __module__: "omo", __hash__: agentDefaultsHash(old) };
  }
  agents.librarian.model = "user-model";
  delete agents.explore.__module__;
  const edited = { ...agents.librarian };
  const unmarked = { ...agents.explore };
  const f = modelsFixture(t, agents);
  assert.equal(mergeModuleAgentsToModels("omo", mod, path.resolve(__dirname, "..")), true);
  const merged = f.read().agents;
  assert.deepEqual(merged.librarian, edited);
  assert.deepEqual(merged.explore, unmarked);
  for (const name of ["oracle", "develop", "frontend-ui-ux-engineer", "document-writer"]) {
    assert.deepEqual(merged[name], { ...mod.agents[name], __module__: "omo", __hash__: agentDefaultsHash(mod.agents[name]) });
  }
});


test("an empty ownership record prevents uninstall from adopting skipped files", async (t) => {
  const f = fixture(t);
  const source = path.join(f.installDir, "source", "commands");
  const target = path.join(f.installDir, "commands", "review.md");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(path.join(source, "review.md"), "source");
  fs.writeFileSync(target, "user content");
  const config = { modules: { test: { operations: [{ type: "merge_dir", source: "source" }] } } };
  const result = await applyModule("test", config, f.installDir, f.installDir, true, null, null, false);
  assert.deepEqual(result.merge_dir_files, []);
  upsertModuleStatus(f.installDir, result);
  fs.writeFileSync(target, "source");
  await uninstallModule("test", config, f.installDir, f.installDir, false);
  assert.equal(fs.readFileSync(target, "utf8"), "source");
});

test("missing models use the template and retain its non-agent defaults", (t) => {
  const f = modelsFixture(t);
  const repoRoot = path.dirname(path.dirname(f.modelsPath));
  const templates = path.join(repoRoot, "templates");
  fs.mkdirSync(templates);
  fs.writeFileSync(path.join(templates, "models.json.example"), JSON.stringify({
    default_backend: "custom", backends: { custom: { api_key: "keep" } }, agents: { unrelated: { model: "template" } },
  }));
  assert.equal(mergeModuleAgentsToModels("omo", { agents: { oracle: { model: "new" } } }, repoRoot), true);
  const models = f.read();
  assert.equal(models.default_backend, "custom");
  assert.deepEqual(models.backends, { custom: { api_key: "keep" } });
  assert.deepEqual(Object.keys(models.agents), ["oracle"]);
});

for (const type of ["copy_dir", "copy_file"]) {
  test("legacy " + type + " ignores bare shared targets, including trailing separators", async (t) => {
    const f = fixture(t);
    const modules = {};
    for (const target of ["hooks", "commands/", "agents", "skills/"]) {
      fs.mkdirSync(path.join(f.installDir, target));
      modules[target] = { operations: [{ type, target, source: "unused" }] };
    }
    assert.deepEqual(await detectInstalledModuleNames({ modules }, f.installDir, f.installDir), []);
    fs.mkdirSync(path.join(f.installDir, "skills", "dedicated"));
    modules.dedicated = { operations: [{ type, target: "skills/dedicated", source: "unused" }] };
    assert.deepEqual(await detectInstalledModuleNames({ modules }, f.installDir, f.installDir), ["dedicated"]);
  });
}


for (const file of ["installed_modules.json", "settings.json", "models.json"]) {
  test("JSON preflight prevents install/update/uninstall changes for corrupt " + file, async (t) => {
    const f = fixture(t);
    const models = modelsFixture(t, {});
    const source = path.join(f.installDir, "source.txt");
    const target = path.join(f.installDir, "module.txt");
    fs.writeFileSync(source, "module content");
    upsertModuleStatus(f.installDir, { module: "essentials" });
    const corruptPath = file === "models.json" ? models.modelsPath : path.join(f.installDir, file);
    fs.writeFileSync(corruptPath, "{invalid");
    const before = fs.readdirSync(f.installDir).sort();
    const config = { modules: { test: { operations: [{ type: "copy_file", source: "source.txt", target: "module.txt" }] } } };
    await assert.rejects(applyModule("test", config, f.installDir, f.installDir, false), invalidJsonError(corruptPath, "{invalid"));
    assert.equal(fs.existsSync(target), false);
    for (const args of [[], ["--update"], ["uninstall", "--module", "essentials", "--yes"]]) {
      const result = spawnSync(process.execPath, [cliPath, ...args, "--offline", "--skip-wrapper",
        "--install-dir", f.installDir], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(corruptPath), result.stderr);
      assert.deepEqual(fs.readdirSync(f.installDir).sort(), before);
      assert.equal(fs.existsSync(path.join(f.installDir, "commands")), false);
      assert.equal(fs.readFileSync(corruptPath, "utf8"), "{invalid");
    }
    fs.writeFileSync(target, "installed module");
    await assert.rejects(uninstallModule("test", config, f.installDir, f.installDir, false), invalidJsonError(corruptPath, "{invalid"));
    assert.equal(fs.readFileSync(target, "utf8"), "installed module");
  });
}

for (const failure of ["merge_hooks", "merge_agents"]) {
  test(failure + " failure after copying persists ownership and failed status", async (t) => {
    const f = fixture(t);
    const models = modelsFixture(t, {});
    const source = path.join(f.installDir, "source");
    fs.mkdirSync(path.join(source, "commands"), { recursive: true });
    fs.writeFileSync(path.join(source, "commands", "test.md"), "module command");
    fs.mkdirSync(path.join(source, "hooks"));
    fs.writeFileSync(path.join(source, "hooks", "hooks.json"), JSON.stringify(doHooks));
    const config = { modules: { test: {
      operations: [
        { type: "merge_dir", source: "source" },
        { type: "copy_dir", source: "source", target: "skills/test" },
      ],
      agents: { oracle: { model: "test-model" } },
    } } };
    const failedPath = failure === "merge_hooks" ? f.settingsPath : models.modelsPath;
    const writeFileSync = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", function(filePath, ...args) {
      if (filePath === failedPath) throw new Error("injected merge write failure");
      return writeFileSync.call(this, filePath, ...args);
    });
    await assert.rejects(applyModule("test", config, f.installDir, f.installDir, false), /injected merge write failure/);
    assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "test.md"), "utf8"), "module command");
    const status = loadInstalledStatus(f.installDir).modules.test;
    assert.equal(status.status, "failed");
    assert.ok(status.merge_dir_files.includes("commands/test.md"));
    assert.deepEqual(status.operations.at(-1), { type: failure, status: "failed", error: "injected merge write failure" });
  });
}
