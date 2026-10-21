"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const {
  normalizeHookCommand,
  hookEntryKey,
  entryPointsInto,
  mergeHooksToSettings,
  unmergeHooksFromSettings,
  mergeModuleHooks,
  uninstallModule,
  parseArgs,
} = require("../bin/cli.js");

const doHooks = require("../skills/do/hooks/hooks.json");
const globalHooks = require("../hooks/hooks.json");
const cliPath = path.resolve(__dirname, "../bin/cli.js");

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

for (const state of ["missing", "empty", "without hooks"]) {
  test("merge handles " + state + " settings.json", (t) => {
    const f = fixture(t, { permissions: { allow: ["Read"] } });
    if (state === "missing") fs.unlinkSync(f.settingsPath);
    if (state === "empty") fs.writeFileSync(f.settingsPath, "");
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
