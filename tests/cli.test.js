"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { execFile, spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

// Keep every in-process and spawned installer test away from the developer's home.
const originalEnv = { ...process.env };
const originalHome = process.platform === "win32"
  ? (originalEnv.USERPROFILE || originalEnv.HOME || os.homedir())
  : (originalEnv.HOME || os.homedir());
const originalModelsPath = path.join(originalHome, ".codeagent", "models.json");
const originalModelsSnapshot = fs.existsSync(originalModelsPath)
  ? { hash: crypto.createHash("sha256").update(fs.readFileSync(originalModelsPath)).digest("hex"), mtimeMs: fs.statSync(originalModelsPath).mtimeMs }
  : null;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-test-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;
process.on("exit", () => {
  try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch {}
});
const {
  renderMenuFrame,
  installDefaultConfigs,
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

function menuItems(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `item:${i}`, label: `Item ${i + 1}` }));
}

function menuLines(frame) {
  return frame.slice("\x1b[H".length, -"\x1b[J".length).split("\n");
}

test("menu frames use home and line erasure without clearing the screen", () => {
  const { frame } = renderMenuFrame(menuItems(2), 0, new Set(), 0, "Menu", 80, 24);
  assert.ok(frame.startsWith("\x1b[H"));
  assert.ok(frame.endsWith("\x1b[J"));
  assert.ok(!frame.includes("\x1b[2J"));
  for (const line of menuLines(frame)) assert.ok(line.endsWith("\x1b[K"));
});

test("menu lines fit the terminal width and preserve short labels", () => {
  const items = [{ id: "long", label: "x".repeat(100) }, { id: "short", label: "OK" }];
  for (const columns of [30, 5, undefined]) {
    const { frame } = renderMenuFrame(items, 0, new Set(), 0, "Title".repeat(30), columns, 24);
    const lines = menuLines(frame).map((line) => line.slice(0, -3));
    const width = Math.max(10, (columns || 80) - 1);
    assert.ok(lines.every((line) => line.length <= width));
    assert.equal(lines[0].length, width);
    assert.ok(lines[0].endsWith("…"));
    assert.ok(lines[1].length <= width);
    assert.equal(lines[3].length, width);
    assert.ok(lines[3].endsWith("…"));
    assert.equal(lines[4], "  [ ] OK");
  }
});

test("menu windows scroll only when needed and follow wrap-around", () => {
  const items = menuItems(23);
  function render(idx, offset, rows = 10) {
    return renderMenuFrame(items, idx, new Set(), offset, "Menu", 80, rows);
  }
  let result = render(0, 0);
  assert.equal(menuLines(result.frame).length - 3, 6);
  assert.equal(result.offset, 0);
  assert.match(result.frame, /\(1\/23\)/);
  result = render(5, result.offset);
  assert.equal(result.offset, 0);
  result = render(6, result.offset);
  assert.equal(result.offset, 1);
  assert.match(result.frame, /> \[ \] Item 7\x1b\[K/);
  assert.match(result.frame, /\(7\/23\)/);
  result = render(5, result.offset);
  assert.equal(result.offset, 1);
  result = render(0, result.offset);
  assert.equal(result.offset, 0);
  result = render(22, result.offset);
  assert.equal(result.offset, 17);
  result = render(0, result.offset);
  assert.equal(result.offset, 0);
  assert.doesNotMatch(render(0, 0, 30).frame, /\(1\/23\)/);
  assert.equal(menuLines(render(0, 0, 30).frame).length - 3, 23);
  assert.equal(menuLines(render(22, 17, 4).frame).length - 3, 1);
  assert.equal(menuLines(render(0, 0, undefined).frame).length - 3, 6);
  const fallback = renderMenuFrame(items, 0, new Set(), 0, "Menu");
  assert.equal(menuLines(fallback.frame).length - 3, 20);
});

test("menu frames show cursor and selection markers independently", () => {
  const { frame } = renderMenuFrame(menuItems(3), 1, new Set(["item:0", "item:1"]), 0, "Menu", 80, 24);
  assert.deepEqual(menuLines(frame).slice(3), [
    "  [x] Item 1\x1b[K", "> [x] Item 2\x1b[K", "  [ ] Item 3\x1b[K",
  ]);
});

function menuSandbox() {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const writes = [];
  const rawModes = [];
  const exits = [];
  let pauses = 0;
  stdin.isTTY = true;
  stdin.setRawMode = (mode) => rawModes.push(mode);
  stdin.pause = () => { pauses++; };
  stdout.columns = 80;
  stdout.rows = 10;
  stdout.write = (value) => { writes.push(value); return true; };
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "readline" ? { emitKeypressEvents: () => {} } : require(name),
    process: { stdin, stdout, env: { ...process.env }, platform: process.platform,
      exit: (code) => {
        assert.equal(writes[writes.length - 1], "\x1b[?25h\x1b[?1049l");
        assert.equal(stdin.listenerCount("keypress"), 0);
        assert.equal(stdout.listenerCount("resize"), 0);
        assert.equal(rawModes[rawModes.length - 1], false);
        assert.equal(pauses, 1);
        exits.push(code);
      } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") +
    "\nmodule.exports.promptMultiSelect = promptMultiSelect;", sandbox);
  return { prompt: sandbox.module.exports.promptMultiSelect, stdin, stdout, writes, rawModes, exits,
    pauses: () => pauses };
}

function assertMenuClosed(menu) {
  assert.equal(menu.writes.filter((value) => value === "\x1b[?25h\x1b[?1049l").length, 1);
  assert.deepEqual(menu.rawModes, [true, false]);
  assert.equal(menu.stdin.listenerCount("keypress"), 0);
  assert.equal(menu.stdout.listenerCount("resize"), 0);
  assert.equal(menu.pauses(), 1);
}

test("interactive menu writes one frame per key and restores on Enter", async () => {
  const menu = menuSandbox();
  const items = menuItems(23);
  const result = menu.prompt(items, "Menu");
  assert.equal(menu.writes[0], "\x1b[?1049h\x1b[?25l");
  assert.equal(menu.writes.length, 2);
  const onKey = menu.stdin.listeners("keypress")[0];
  for (const key of ["space", "down", "space", "space", "up", "up", "space", "down", "right"]) {
    const before = menu.writes.length;
    menu.stdin.emit("keypress", "", { name: key });
    assert.equal(menu.writes.length, before + 1);
  }
  assert.match(menu.writes[7], /> \[ \] Item 23/);
  assert.match(menu.writes[9], /> \[x\] Item 1/);
  menu.stdin.emit("keypress", "", { name: "return" });
  assert.deepEqual(Array.from(await result), [items[0], items[22]]);
  assertMenuClosed(menu);
  const before = menu.writes.length;
  onKey("", { name: "return" });
  menu.stdout.emit("resize");
  assert.equal(menu.writes.length, before);
  assert.ok(menu.writes.every((value) => !value.includes("\x1b[2J")));
});

test("interactive menu redraws on resize and removes its listener", async () => {
  const menu = menuSandbox();
  const result = menu.prompt(menuItems(23), "Menu");
  menu.stdout.columns = 25;
  menu.stdout.rows = 7;
  const before = menu.writes.length;
  menu.stdout.emit("resize");
  assert.equal(menu.writes.length, before + 1);
  const lines = menuLines(menu.writes[menu.writes.length - 1]);
  assert.equal(lines.length - 3, 3);
  assert.ok(lines.every((line) => line.slice(0, -3).length <= 24));
  menu.stdin.emit("keypress", "", { name: "return" });
  await result;
  assertMenuClosed(menu);
});

for (const [key, code] of [[{ name: "q" }, 0], [{ name: "c", ctrl: true }, 130]]) {
  test(`interactive menu restores the terminal before exit ${code}`, () => {
    const menu = menuSandbox();
    menu.prompt(menuItems(2), "Menu");
    const onKey = menu.stdin.listeners("keypress")[0];
    menu.stdin.emit("keypress", "", key);
    assert.deepEqual(menu.exits, [code]);
    assertMenuClosed(menu);
    onKey("", key);
    assert.deepEqual(menu.exits, [code]);
    assertMenuClosed(menu);
  });
}

for (const stage of ["initial render", "keypress render", "resize render", "keypress selection"]) {
  test(`interactive menu cleans up after a throwing ${stage}`, async () => {
    const menu = menuSandbox();
    const items = menuItems(2);
    if (stage === "initial render") {
      Object.defineProperty(items[0], "label", { get() { throw new Error("render failed"); } });
    }
    const result = menu.prompt(items, "Menu");
    const rejection = assert.rejects(result, /render failed|selection failed/);
    if (stage === "keypress selection") {
      Object.defineProperty(items[0], "id", { get() { throw new Error("selection failed"); } });
      menu.stdin.emit("keypress", "", { name: "space" });
    } else if (stage !== "initial render") {
      const write = menu.stdout.write;
      menu.stdout.write = (value) => {
        if (value.startsWith("\x1b[H")) throw new Error("render failed");
        return write(value);
      };
      if (stage === "resize render") menu.stdout.emit("resize");
      else menu.stdin.emit("keypress", "", { name: "down" });
    }
    await rejection;
    assertMenuClosed(menu);
  });
}

test("interactive menu rejects non-TTY stdin without changing the terminal", async () => {
  const menu = menuSandbox();
  menu.stdin.isTTY = false;
  await assert.rejects(menu.prompt(menuItems(2), "Menu"), /No TTY\. Use --list or run in an interactive terminal\./);
  assert.deepEqual(menu.writes, []);
  assert.deepEqual(menu.rawModes, []);
  assert.equal(menu.stdin.listenerCount("keypress"), 0);
  assert.equal(menu.stdout.listenerCount("resize"), 0);
});

for (const [platform, cmd, script] of [
  ["win32", "cmd.exe", "install.bat"],
  ["linux", "bash", "install.sh"],
]) {
  test(`installScriptCommand uses an absolute script path for ${platform}`, () => {
    const repoRoot = path.resolve(__dirname, "..");
    const command = installScriptCommand(repoRoot, platform);
    assert.deepEqual(command, {
      cmd,
      args: platform === "win32"
        ? ["/d", "/s", "/c", `""${path.join(repoRoot, script)}""`]
        : [path.join(repoRoot, script)],
      ...(platform === "win32" ? { windowsVerbatimArguments: true } : {}),
    });
    const scriptPath = command.args[command.args.length - 1].replace(/^"+|"+$/g, "");
    assert.equal(path.isAbsolute(scriptPath), true);
    assert.equal(path.dirname(scriptPath), repoRoot);
  });
}

test("install.sh maps MSYS family platforms to Windows release assets without downloading", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-uname-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uname = path.join(root, "uname");
  const curl = path.join(root, "curl");
  const urlFile = path.join(root, "url");
  fs.writeFileSync(uname, "#!/bin/sh\ncase \"$1\" in -s) echo MINGW64_NT-10.0;; -m) echo x86_64;; esac\n");
  fs.writeFileSync(curl, `#!/bin/sh\ncase "$*" in *SHA256SUMS*) printf 404; exit 0;; esac\nprintf '%s' "$2" > "${urlFile.replace(/\\/g, "/")}"\nprintf '#!/bin/sh\\nexit 0\\n' > "$4"\n`);
  fs.chmodSync(uname, 0o755);
  fs.chmodSync(curl, 0o755);
  const result = spawnSync("bash", [path.resolve(__dirname, "../install.sh")], {
    encoding: "utf8", env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`,
      HOME: root, USERPROFILE: root, SHELL: "/bin/bash", INSTALL_DIR: path.join(root, "install"), SKIP_WARNING: "1" }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, "install", "bin", "codeagent-wrapper.exe")));
  assert.equal(fs.existsSync(path.join(root, "install", "bin", "codeagent-wrapper")), false);
  assert.equal(fs.readFileSync(urlFile, "utf8"),
    "https://github.com/miraserver/myclaude/releases/latest/download/codeagent-wrapper-windows-amd64.exe");
});

test("install.sh passes shell syntax validation", () => {
  const result = spawnSync("bash", ["-n", path.resolve(__dirname, "../install.sh")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

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

test("wrapper installer sets SKIP_WARNING and reports spawn errors", async () => {
  let spawnOptions;
  let output = "";
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "child_process" ? {
      spawn: (_cmd, _args, options) => {
        spawnOptions = options;
        const { EventEmitter } = require("node:events");
        const child = new EventEmitter();
        process.nextTick(() => child.emit("error", new Error("ENOENT")));
        return child;
      }, spawnSync,
    } : require(name),
    process: { platform: "win32", env: {}, stdout: { write: (s) => { output += s; } } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") +
    "\nmodule.exports.testRunInstallSh = runInstallSh;", sandbox);
  await assert.rejects(sandbox.module.exports.testRunInstallSh("C:\\repo & dir", "C:\\install", null),
    /Unable to start install script \(cmd\.exe\): ENOENT/);
  assert.equal(spawnOptions.env.SKIP_WARNING, "1");
  assert.equal(spawnOptions.windowsVerbatimArguments, true);
  assert.equal(output, "");
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

test("CLI update with no status file does not adopt existing module paths", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.installDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(f.installDir, "hooks", "existing.py"), "user file");
  const result = spawnSync(process.execPath, [cliPath, "--update", "--offline", "--skip-wrapper",
    "--install-dir", f.installDir], { encoding: "utf8", timeout: 10000, env: {
      ...process.env, HOME: f.installDir, USERPROFILE: f.installDir,
    } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No installation status found/);
  assert.equal(fs.existsSync(path.join(f.installDir, "installed_modules.json")), false);
  assert.equal(fs.readFileSync(path.join(f.installDir, "hooks", "existing.py"), "utf8"), "user file");
});

test("matching skill selection installs its configured module and records status", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-skill-module-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const installDir = path.join(root, "install");
  fs.mkdirSync(path.join(repo, "skills", "do"), { recursive: true });
  fs.mkdirSync(path.join(repo, "source"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "do", "SKILL.md"), "skill only");
  fs.writeFileSync(path.join(repo, "source", "wrapper.txt"), "module payload");
  const sandbox = {
    module: { exports: {} }, __dirname: path.join(repo, "bin"),
    require: (name) => name === "child_process" ? { spawn: () => { throw new Error("unexpected spawn"); }, spawnSync } : require(name),
    process: { platform: process.platform, env: { ...process.env }, stdout: { write() {} } },
  };
  fs.mkdirSync(path.join(repo, "bin"));
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + "\nmodule.exports.testInstallSelected = installSelected;", sandbox);
  await sandbox.module.exports.testInstallSelected([{ kind: "skill", skillName: "do" }], null,
    { modules: { do: { operations: [{ type: "copy_file", source: "source/wrapper.txt", target: "bin/wrapper.txt" }] } } },
    installDir, false, false, true);
  assert.equal(fs.readFileSync(path.join(installDir, "bin", "wrapper.txt"), "utf8"), "module payload");
  assert.equal(fs.existsSync(path.join(installDir, "skills", "do")), false);
  assert.ok(fs.existsSync(path.join(installDir, "installed_modules.json")));
});

test("standalone skill install, update, and uninstall track byte-equal ownership", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-standalone-skill-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const installDir = path.join(root, "install");
  fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
  fs.mkdirSync(path.join(repo, "skills", "solo"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "solo", "SKILL.md"), "v1");
  const sandbox = {
    module: { exports: {} }, __dirname: path.join(repo, "bin"),
    require: (name) => name === "child_process" ? { spawn: () => { throw new Error("unexpected spawn"); }, spawnSync } : require(name),
    process: { platform: process.platform, env: { ...process.env }, stdout: { write() {} }, stderr: { write() {} } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
    repoRootFromHere = () => ${JSON.stringify(repo)};
    module.exports.testInstallSelected = installSelected;
    module.exports.testUpdate = updateInstalledModules;
    module.exports.testUninstall = uninstallModule;
  `, sandbox);
  await sandbox.module.exports.testInstallSelected([{ kind: "skill", skillName: "solo" }], null, {}, installDir, false, false, true);
  let entry = loadInstalledStatus(installDir).modules["skill:solo"];
  assert.equal(entry.version, "offline");
  assert.deepEqual(entry.files, { "skills/solo/SKILL.md": sha256("v1") });
  fs.writeFileSync(path.join(repo, "skills", "solo", "SKILL.md"), "v2");
  await sandbox.module.exports.testUpdate(installDir, null, { modules: {} }, false, false, true);
  assert.equal(fs.readFileSync(path.join(installDir, "skills", "solo", "SKILL.md"), "utf8"), "v2");
  assert.equal(loadInstalledStatus(installDir).modules["skill:solo"].version, "offline");
  assert.deepEqual(loadInstalledStatus(installDir).modules["skill:solo"].files, { "skills/solo/SKILL.md": sha256("v2") });
  fs.writeFileSync(path.join(installDir, "skills", "solo", "user.txt"), "preserve");
  await sandbox.module.exports.testUninstall("skill:solo", {}, repo, installDir, false);
  assert.equal(fs.existsSync(path.join(installDir, "skills", "solo", "SKILL.md")), false);
  assert.equal(fs.readFileSync(path.join(installDir, "skills", "solo", "user.txt"), "utf8"), "preserve");
  assert.equal(loadInstalledStatus(installDir).modules["skill:solo"], undefined);
});

test("latest tag fetch failure warns and uses bundled offline content", async (t) => {
  const f = fixture(t);
  let stdout = "";
  let stderr = "";
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(cliPath),
    require,
    process: { argv: ["node", cliPath, "--list", "--install-dir", f.installDir], cwd: () => process.cwd(), env: { ...process.env }, stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
    fetchLatestTag = async () => { throw new Error("stub fetch failure"); };
    module.exports.testMain = main;
  `, sandbox);
  await sandbox.module.exports.testMain();
  assert.match(stderr, /stub fetch failure/);
  assert.match(stderr, /using bundled package content in offline mode/);
  assert.match(stdout, /module:/);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude a b&c-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "install.bat"), '@echo off\r\necho marker> "%~dp0marker.txt"\r\nexit /b 0\r\n');
  const { cmd, args, windowsVerbatimArguments } = installScriptCommand(dir);
  const result = spawnSync(cmd, args, {
    cwd: dir,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, NoDefaultCurrentDirectoryInExePath: "1" },
    windowsVerbatimArguments,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr?.toString());
  assert.equal(fs.readFileSync(path.join(dir, "marker.txt"), "utf8").trim(), "marker");
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

function pythonSandbox(repo, platform, okCmd = null, t, envOverrides = {}) {
  const source = fs.readFileSync(cliPath, "utf8");
  const root = path.dirname(repo);
  const calls = [];
  let wrapperCalls = 0;
  const sandbox = {
    module: { exports: {} }, __dirname: path.join(repo, "bin"),
    require: (name) => name === "child_process" ? {
      spawn: () => { wrapperCalls++; throw new Error("wrapper should not run"); },
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: cmd === okCmd ? 0 : 9009 };
      },
    } : require(name),
    process: {
      platform,
      env: { HOME: root, USERPROFILE: root, ...envOverrides },
      stdout: { write() {} },
      stderr: { write() {} },
    },
  };
  vm.runInNewContext(source + `
    repoRootFromHere = () => ${JSON.stringify(repo)};
    module.exports.install = installSelected;
    module.exports.update = updateInstalledModules;
    module.exports.uninstall = uninstallModule;
  `, sandbox);
  if (t) t.after(() => {});
  return { api: sandbox.module.exports, calls, wrapperCalls: () => wrapperCalls };
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

test("exact untagged duplicate stays user-owned after module uninstall", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.settingsPath, JSON.stringify({
    hooks: { Stop: [commandEntry('python3 "' + f.root + '/hooks/stop-hook.py"')] },
  }));
  assert.equal(mergeHooksToSettings("do", doHooks, f.installDir, f.root), false);
  assert.equal(f.read().hooks.Stop.length, 1);
  assert.equal(f.read().hooks.Stop[0].__module__, undefined);
  unmergeHooksFromSettings("do", f.installDir);
  assert.equal(f.read().hooks.Stop.length, 1);
});

test("untagged hooks with different quoting and interpreters are preserved", (t) => {
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
  assert.equal(f.read().hooks.Stop.length, 2);
  assert.equal(f.read().hooks.Stop.every((entry) => !entry.__module__), true);
  assert.equal(f.read().hooks.SubagentStop.length, 1);
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
    foreign[0], commandEntry("python '" + f.root.replace(/\//g, "\\") + "\\hooks\\stop-hook.py'"), foreign[1], other, commandEntry('python3 "' + f.root + '-other/keep.py"'),
  ]);
  assert.equal(f.read().hooks.PreToolUse.length, 1);
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
  assert.deepEqual(Object.keys(f.read().hooks), ["Stop", "PreToolUse"]);
  assert.equal(mergeModuleHooks("claudekit", mod, f.installDir), false);
});

test("course installs its discoverable subagent and uninstall preserves foreign agents", async (t) => {
  const f = fixture(t);
  const repoRoot = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "config.json"), "utf8"));
  const agent = path.join(f.installDir, "agents", "dev-plan-generator.md");
  const other = path.join(f.installDir, "agents", "other.md");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "foreign agent\n");

  // Offline mode exercises the real course operations without installing a binary.
  const result = await applyModule("course", config, repoRoot, f.installDir,
    false, null, null, false, true);
  assert.equal(result.status, "success");
  assert.deepEqual(fs.readFileSync(agent),
    fs.readFileSync(path.join(repoRoot, "skills/dev/agents/dev-plan-generator.md")));
  upsertModuleStatus(f.installDir, result);

  await uninstallModule("course", config, repoRoot, f.installDir, false);
  assert.equal(fs.existsSync(agent), false);
  assert.equal(fs.readFileSync(other, "utf8"), "foreign agent\n");
});

for (const scenario of ["identical", "user", "missing", "missing source", "unreadable source"]) {
  test(`copy_file uninstall: ${scenario}`, async (t) => {
    const f = fixture(t);
    for (const name of ["HOME", "USERPROFILE"]) {
      const previous = process.env[name];
      process.env[name] = f.installDir;
      t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      });
    }
    const source = path.join(f.installDir, "source.md");
    const target = path.join(f.installDir, "agents", "dev-plan-generator.md");
    const bytes = Buffer.from([0, 255, 13, 10]);
    fs.writeFileSync(source, bytes);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const config = { modules: { demo: { operations: [
      { type: "copy_file", source: "source.md", target: "agents/dev-plan-generator.md" },
    ] } } };
    if (scenario === "user") fs.writeFileSync(target, "user agent\n");
    const result = await applyModule("demo", config, f.installDir, f.installDir,
      false, null, null, false, true);
    assert.equal(result.status, "success");
    assert.deepEqual(fs.readFileSync(target), scenario === "user" ? Buffer.from("user agent\n") : bytes);
    if (scenario === "missing") fs.unlinkSync(target);
    if (scenario.includes("source")) fs.unlinkSync(source);
    if (scenario === "unreadable source") fs.mkdirSync(source);
    let output = "";
    const write = process.stdout.write;
    process.stdout.write = (value) => { output += value; return true; };
    try {
      await uninstallModule("demo", config, f.installDir, f.installDir, false);
    } finally { process.stdout.write = write; }
    if (scenario === "user") {
      assert.equal(fs.readFileSync(target, "utf8"), "user agent\n");
      assert.ok(output.includes(`Keeping ${target}: differs from the installed copy`));
    } else assert.equal(fs.existsSync(target), false);
  });
}

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
  assert.equal(f.read().hooks.Stop.length, 1);
});

test("uninstall missing copy_dir source preserves target and dry-run changes nothing", async (t) => {
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
  assert.equal(fs.existsSync(target), true);
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

test("Python probing follows platform candidates, probes non-Windows, and caches null", (t) => {
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
  assert.equal(fallbackSandbox.module.exports.findPythonCommand(), null);
  assert.equal(fallbackSandbox.module.exports.findPythonCommand(), null);
  assert.equal(calls.length, 3);

  calls.length = 0;
  const unixSandbox = {
    module: { exports: {} },
    require: (name) => name === "child_process" ? {
      spawnSync: (cmd, args, options) => { calls.push({ cmd, args, options }); return { status: 1 }; },
    } : require(name),
    process: { platform: "linux", env: {}, stderr: { write() {} } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8"), unixSandbox);
  assert.equal(unixSandbox.module.exports.findPythonCommand(), null);
  assert.deepEqual(calls.map((call) => call.cmd), ["python3"]);
});

test("Python override is verbatim and skips interpreter probing", (t) => {
  fixture(t);
  let calls = 0;
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "child_process" ? { spawnSync: () => { calls++; return { status: 1 }; } } : require(name),
    process: { platform: "win32", env: { MYCLAUDE_PYTHON: 'C:\\Python path\\python.exe -X' }, stderr: { write() {} } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8"), sandbox);
  assert.equal(sandbox.module.exports.findPythonCommand(), 'C:\\Python path\\python.exe -X');
  assert.equal(calls, 0);
});

test("Python hook preflight rejects before install writes and accepts working Windows candidates", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-python-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const installDir = path.join(root, "install");
  fs.mkdirSync(path.join(repo, "skills", "demo", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skills", "demo", "hooks", "hooks.json"), JSON.stringify({ hooks: {
    Stop: [commandEntry('python3 "${CLAUDE_PLUGIN_ROOT}/hooks/stop.py"')],
  } }));
  const source = fs.readFileSync(cliPath, "utf8");
  const config = { modules: { demo: { operations: [{ type: "copy_dir", source: "skills/demo", target: "skills/demo" }] } } };
  const run = async (okCmd) => {
    let wrapperCalls = 0;
    const sandbox = {
      module: { exports: {} }, __dirname: path.join(repo, "bin"),
      require: (name) => name === "child_process" ? {
        spawn: () => { wrapperCalls++; throw new Error("wrapper should not run"); },
        spawnSync: (cmd) => ({ status: cmd === okCmd ? 0 : 9009 }),
      } : require(name),
      process: { platform: "win32", env: { HOME: root, USERPROFILE: root }, stdout: { write() {} }, stderr: { write() {} } },
    };
    vm.runInNewContext(source + `
      repoRootFromHere = () => ${JSON.stringify(repo)};
      module.exports.install = installSelected;
      module.exports.update = updateInstalledModules;
    `, sandbox);
    return { api: sandbox.module.exports, wrapperCalls: () => wrapperCalls };
  };
  const failed = await run(null);
  await assert.rejects(failed.api.install([{ kind: "module", moduleName: "demo", id: "demo" }], null,
    config, installDir, false, false, true), (err) => {
    assert.match(err.message, /hooks of: demo/);
    assert.match(err.message, /MYCLAUDE_PYTHON/);
    assert.match(err.message, /Microsoft Store stubs/);
    return true;
  });
  assert.equal(fs.existsSync(installDir), false);
  assert.equal(failed.wrapperCalls(), 0);

  for (const [candidate, prefix] of [["python", 'python "'], ["py", 'py -3 "']]) {
    const dir = path.join(root, candidate);
    const working = await run(candidate);
    await working.api.install([{ kind: "module", moduleName: "demo", id: "demo" }], null,
      config, dir, false, false, true);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.ok(settings.hooks.Stop[0].hooks[0].command.startsWith(prefix));
  }
});

function makePythonModule(t, name = "demo", withHooks = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-python-case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const installDir = path.join(root, "install");
  const source = path.join(repo, "skills", name);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "payload.txt"), "payload\n");
  if (withHooks) {
    fs.mkdirSync(path.join(source, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(source, "hooks", "hooks.json"), JSON.stringify({ hooks: {
      Stop: [commandEntry('python3 "${CLAUDE_PLUGIN_ROOT}/hooks/stop.py"')],
    } }));
  }
  const config = { modules: { [name]: { operations: [{ type: "copy_dir", source: `skills/${name}`, target: `skills/${name}` }] } } };
  return { root, repo, installDir, config, name };
}

test("update Python preflight preserves all files and skips migration and wrapper", async (t) => {
  const f = makePythonModule(t);
  fs.mkdirSync(path.join(f.installDir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(f.installDir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(f.installDir, "skills", "demo", "payload.txt"), "old\n");
  fs.writeFileSync(path.join(f.installDir, "settings.json"), JSON.stringify({ hooks: { Stop: [commandEntry('python3 "old.py"', { __module__: "demo" })] } }, null, 2) + "\n");
  fs.writeFileSync(path.join(f.installDir, ".claude-plugin", "plugin.json"), "legacy\n");
  fs.writeFileSync(path.join(f.installDir, "installed_modules.json"), JSON.stringify({ modules: { demo: { module: "demo", status: "installed", files: { ".claude-plugin/plugin.json": "deadbeef" } } } }, null, 2) + "\n");
  const before = new Map();
  for (const file of ["settings.json", "installed_modules.json", "skills/demo/payload.txt", ".claude-plugin/plugin.json"]) before.set(file, fs.readFileSync(path.join(f.installDir, file)));
  const s = pythonSandbox(f.repo, "win32", null);
  await assert.rejects(s.api.update(f.installDir, null, f.config, false, false, true), /Python 3 is required by hooks of: demo/);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(f.installDir, file)), bytes, file);
  assert.equal(s.wrapperCalls(), 0);
});

test("update rewrites previously installed python3 hooks when Python appears", async (t) => {
  const f = makePythonModule(t);
  fs.mkdirSync(path.join(f.installDir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(f.installDir, "settings.json"), JSON.stringify({ hooks: { Stop: [commandEntry('python3 "old.py"', { __module__: "demo" })] } }, null, 2));
  fs.writeFileSync(path.join(f.installDir, "installed_modules.json"), JSON.stringify({ modules: { demo: { module: "demo", status: "installed" } } }, null, 2));
  const s = pythonSandbox(f.repo, "win32", "python");
  await s.api.update(f.installDir, null, f.config, false, false, true);
  const hooks = JSON.parse(fs.readFileSync(path.join(f.installDir, "settings.json"), "utf8")).hooks.Stop;
  assert.ok(hooks.some((e) => e.__module__ === "demo" && e.hooks[0].command.startsWith("python \"")));
  assert.equal(hooks.some((e) => e.__module__ === "demo" && e.hooks[0].command.startsWith("python3 ")), false);
});

test("no-hook install, Linux failure, and bypass operations avoid inappropriate probing", async (t) => {
  const noHooks = makePythonModule(t, "plain", false);
  const plain = pythonSandbox(noHooks.repo, "win32", null);
  await plain.api.install([{ kind: "module", moduleName: "plain", id: "plain" }], null, noHooks.config, noHooks.installDir, false, false, true);
  assert.equal(fs.existsSync(path.join(noHooks.installDir, "installed_modules.json")), true);

  const linux = makePythonModule(t);
  const failed = pythonSandbox(linux.repo, "linux", null);
  await assert.rejects(failed.api.install([{ kind: "module", moduleName: "demo", id: "demo" }], null, linux.config, linux.installDir, false, false, true), (err) => {
    assert.match(err.message, /tried: python3/);
    assert.doesNotMatch(err.message, /Microsoft Store/);
    return true;
  });
  assert.equal(fs.existsSync(linux.installDir), false);

  const dry = makePythonModule(t);
  const drySandbox = pythonSandbox(dry.repo, "win32", null);
  await drySandbox.api.install([{ kind: "module", moduleName: "demo", id: "demo" }], null, dry.config, dry.installDir, false, true, true);
  fs.mkdirSync(dry.installDir, { recursive: true });
  fs.writeFileSync(path.join(dry.installDir, "installed_modules.json"), JSON.stringify({ modules: { demo: { module: "demo", status: "installed" } } }));
  await drySandbox.api.update(dry.installDir, null, dry.config, true, false, true);
  await drySandbox.api.uninstall("demo", dry.config, dry.repo, dry.installDir, false);
  assert.equal(drySandbox.calls.length, 0);
});

test("resolvePythonCommand fallback warns once", (t) => {
  fixture(t);
  let warnings = "";
  const sandbox = {
    module: { exports: {} },
    require: (name) => name === "child_process" ? { spawnSync: () => ({ status: 1 }) } : require(name),
    process: { platform: "win32", env: {}, stderr: { write: (s) => { warnings += s; } } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8"), sandbox);
  assert.equal(sandbox.module.exports.resolvePythonCommand(), "python3");
  assert.equal(sandbox.module.exports.resolvePythonCommand(), "python3");
  assert.equal(warnings.split("\n").filter(Boolean).length, 1);
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
  assert.equal(fs.readFileSync(path.join(commands, "review.md"), "utf8"), "original");
  assert.equal(fs.existsSync(path.join(commands, "retired.md")), true);
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

test("legacy detection remains available but update requires recorded status", async (t) => {
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
  const result = runUpdate(f.installDir);
  assert.match(result.stdout, /No installation status found/);
  assert.equal(fs.readFileSync(review, "utf8"), "personal command");
  assert.equal(fs.existsSync(path.join(f.installDir, "installed_modules.json")), false);
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
    for (const args of (file === "models.json" ? [[], ["--update"]] : [[], ["--update"], ["uninstall", "--module", "essentials", "--yes"]])) {
      const result = spawnSync(process.execPath, [cliPath, ...args, "--offline", "--skip-wrapper",
        "--install-dir", f.installDir], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(corruptPath), result.stderr);
      assert.deepEqual(fs.readdirSync(f.installDir).sort(), before);
      assert.equal(fs.existsSync(path.join(f.installDir, "commands")), false);
      assert.equal(fs.readFileSync(corruptPath, "utf8"), "{invalid");
    }
    fs.writeFileSync(target, "installed module");
    if (file === "models.json") await uninstallModule("test", config, f.installDir, f.installDir, false);
    else await assert.rejects(uninstallModule("test", config, f.installDir, f.installDir, false), invalidJsonError(corruptPath, "{invalid"));
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

for (const scenario of ["fresh", "opt-in", "matching CLAUDE.md", "user CLAUDE.md", "existing skill"]) {
  test(`default configs install codeagent dependency safely: ${scenario}`, async (t) => {
    const f = fixture(t);
    modelsFixture(t);
    const repoRoot = path.resolve(__dirname, "..");
    const config = require("../config.json");
    const claude = path.join(f.installDir, "CLAUDE.md");
    const skill = path.join(f.installDir, "skills/codeagent/SKILL.md");
    if (scenario === "matching CLAUDE.md") fs.copyFileSync(path.join(repoRoot, "memorys/CLAUDE.md"), claude);
    if (scenario === "user CLAUDE.md") fs.writeFileSync(claude, "user instructions\n");
    if (scenario === "existing skill") {
      fs.mkdirSync(path.dirname(skill), { recursive: true });
      fs.writeFileSync(skill, "user skill\n");
    }
    upsertModuleStatus(f.installDir, await applyModule("harness", config, repoRoot, f.installDir, false));
    await installDefaultConfigs(f.installDir, repoRoot, scenario === "opt-in");
    if (scenario === "user CLAUDE.md") {
      assert.equal(fs.readFileSync(claude, "utf8"), "user instructions\n");
      assert.equal(fs.existsSync(skill), false);
    } else if (["opt-in", "matching CLAUDE.md"].includes(scenario)) {
      assert.deepEqual(fs.readFileSync(claude), fs.readFileSync(path.join(repoRoot, "memorys/CLAUDE.md")));
      assert.deepEqual(fs.readFileSync(skill), fs.readFileSync(path.join(repoRoot, "skills/codeagent/SKILL.md")));
    } else if (scenario === "existing skill") {
      assert.equal(fs.existsSync(claude), false);
      assert.equal(fs.readFileSync(skill, "utf8"), "user skill\n");
    }
    await uninstallModule("harness", config, repoRoot, f.installDir, false);
    if (scenario === "fresh") assert.equal(fs.existsSync(claude), false);
    if (scenario === "fresh") assert.equal(fs.existsSync(skill), false);
    if (scenario === "existing skill") assert.equal(fs.readFileSync(skill, "utf8"), "user skill\n");
    if (scenario !== "user CLAUDE.md" && scenario !== "fresh") assert.equal(fs.existsSync(skill), true);
  });
}

test("essentials reinstall without force then uninstall removes all owned files and keeps foreign files", async (t) => {
  const f = fixture(t);
  modelsFixture(t);
  const repoRoot = path.resolve(__dirname, "..");
  const config = require("../config.json");
  const foreign = path.join(f.installDir, "commands/review.md");
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, "foreign command\n");
  const install = () => applyModule("essentials", config, repoRoot, f.installDir, false);
  const first = await install();
  upsertModuleStatus(f.installDir, first);
  assert.ok(first.merge_dir_files.length > 0);
  const second = await install();
  upsertModuleStatus(f.installDir, second);
  assert.deepEqual(new Set(loadInstalledStatus(f.installDir).modules.essentials.merge_dir_files), new Set(first.merge_dir_files));
  await uninstallModule("essentials", config, repoRoot, f.installDir, false);
  for (const rel of first.merge_dir_files) assert.equal(fs.existsSync(path.join(f.installDir, rel)), false, rel);
  assert.equal(fs.readFileSync(foreign, "utf8"), "foreign command\n");
});

for (const explicit of [false, true]) {
  test(`update skips unsuccessful entries and respects explicit scope: ${explicit}`, (t) => {
    const f = fixture(t);
    const entries = { do: {}, harness: { status: "installed" }, essentials: { status: "success" },
      omo: { status: "failed" }, claudekit: { status: "rolled_back" } };
    for (const [module, entry] of Object.entries(entries)) upsertModuleStatus(f.installDir, { module, ...entry });
    const before = fs.readFileSync(path.join(f.installDir, "installed_modules.json"));
    const result = runUpdate(f.installDir, "--dry-run", ...(explicit ? ["--module", "do,omo,sparv,claudekit"] : []));
    assert.match(result.stdout, /module:do\n/);
    assert.match(result.stdout, /omo is not installed; run without --update to install it/);
    assert.match(result.stdout, /claudekit is not installed; run without --update to install it/);
    if (explicit) {
      assert.match(result.stdout, /sparv is not installed; run without --update to install it/);
      assert.doesNotMatch(result.stdout, /module:(harness|essentials)\n/);
    } else {
      assert.match(result.stdout, /module:harness\n/);
      assert.match(result.stdout, /module:essentials\n/);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.installDir, "installed_modules.json")), before);
  });
}

test("legacy update prints detected modules and exact recovery command without installing", async (t) => {
  const f = fixture(t);
  for (const name of ["do", "harness"]) fs.mkdirSync(path.join(f.installDir, "skills", name), { recursive: true });
  const result = runUpdate(f.installDir);
  const detected = await detectInstalledModuleNames(require("../config.json"), path.resolve(__dirname, ".."), f.installDir);
  assert.ok(detected.includes("do") && detected.includes("harness"));
  assert.ok(result.stdout.includes(`No installation status found. Detected: ${detected.join(", ")}. Run: npx github:miraserver/myclaude --module ${detected.join(",")} --update`));
  assert.equal(fs.existsSync(path.join(f.installDir, "installed_modules.json")), false);
  const explicit = runUpdate(f.installDir, "--module", "do", "--force");
  assert.match(explicit.stdout, /do is not installed; run without --update to install it/);
  assert.equal(fs.existsSync(path.join(f.installDir, "installed_modules.json")), false);
});

test("explicit update never installs absent or failed modules, even with force", (t) => {
  const f = fixture(t);
  upsertModuleStatus(f.installDir, { module: "do", status: "failed" });
  const before = fs.readFileSync(path.join(f.installDir, "installed_modules.json"));
  const result = runUpdate(f.installDir, "--module", "do,harness", "--force");
  for (const name of ["do", "harness"]) {
    assert.ok(result.stdout.includes(`${name} is not installed; run without --update to install it`));
    assert.equal(fs.existsSync(path.join(f.installDir, "skills", name)), false);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.installDir, "installed_modules.json")), before);
});

for (const checksum of ["valid", "mismatch", "missing", "unlisted"]) {
  test(`install.sh verifies release manifest: ${checksum}`, (t) => {
    const f = fixture(t);
    const toolsDir = path.join(f.installDir, "tools");
    fs.mkdirSync(toolsDir);
    const binary = "#!/bin/sh\nexit 0\n";
    const hash = crypto.createHash("sha256").update(binary).digest("hex");
    const curl = `#!/bin/sh
case "$*" in
  *SHA256SUMS*)
    ${checksum === "missing" ? "printf 404" : `printf '%s  %s\\n' '${checksum === "mismatch" ? "0".repeat(64) : hash}' '${checksum === "unlisted" ? "other" : "codeagent-wrapper-windows-amd64.exe"}' > "$6"; printf 200`}
    ;;
  *) printf '#!/bin/sh\\nexit 0\\n' > "$4";;
esac
`;
    fs.writeFileSync(path.join(toolsDir, "curl"), curl, { mode: 0o755 });
    fs.writeFileSync(path.join(toolsDir, "uname"), '#!/bin/sh\ncase "$1" in -s) echo MINGW64;; -m) echo x86_64;; esac\n', { mode: 0o755 });
    const result = spawnSync("bash", [path.resolve(__dirname, "../install.sh")], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, HOME: f.installDir, USERPROFILE: f.installDir,
        PATH: `${toolsDir}${path.delimiter}${process.env.PATH}`, SKIP_WARNING: "1", SHELL: "/bin/bash", INSTALL_DIR: path.join(f.installDir, "output") },
    });
    assert.equal(result.status, ["valid", "missing"].includes(checksum) ? 0 : 1, result.stderr);
    if (checksum === "missing") assert.match(result.stderr, /WARNING.*SHA256SUMS absent/);
    if (["mismatch", "unlisted"].includes(checksum)) {
      assert.match(result.stderr, /checksum mismatch/);
      assert.equal(fs.existsSync(path.join(f.installDir, "output", "bin")), false);
    }
  });
}

test("claudekit installs global hooks alongside do without owning its skill", async (t) => {
  const f = fixture(t);
  const config = require("../config.json");
  const repoRoot = path.resolve(__dirname, "..");
  assert.deepEqual(config.modules.claudekit.operations.map((op) => op.target), ["hooks"]);
  for (const name of ["do", "claudekit"]) {
    upsertModuleStatus(f.installDir, await applyModule(name, config, repoRoot, f.installDir, false, null, { wrapperInstalled: true }));
  }
  assert.equal(f.read().hooks.Stop[0].__module__, "do");
  assert.ok(f.read().hooks.PreToolUse.some((entry) => entry.__module__ === "claudekit"));
  await uninstallModule("claudekit", config, repoRoot, f.installDir, false);
  assert.ok(fs.existsSync(path.join(f.installDir, "skills", "do", "SKILL.md")));
  assert.equal(f.read().hooks.Stop[0].__module__, "do");
});

test("copy_dir fills existing target and uninstall keeps edited files", async (t) => {
  const f = fixture(t);
  const source = path.join(f.installDir, "source");
  const target = path.join(f.installDir, "hooks");
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, "new.py"), "source");
  fs.writeFileSync(path.join(source, "edited.py"), "source");
  fs.writeFileSync(path.join(target, "edited.py"), "user");
  const config = { modules: { demo: { operations: [{ type: "copy_dir", source: "source", target: "hooks" }] } } };
  await applyModule("demo", config, f.installDir, f.installDir, false);
  assert.equal(fs.readFileSync(path.join(target, "edited.py"), "utf8"), "user");
  assert.equal(fs.readFileSync(path.join(target, "new.py"), "utf8"), "source");
  await uninstallModule("demo", config, f.installDir, f.installDir, false);
  assert.equal(fs.existsSync(path.join(target, "new.py")), false);
  assert.equal(fs.readFileSync(path.join(target, "edited.py"), "utf8"), "user");
});

test("update overwrites copy targets but preserves unowned merge files", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "skill", "nested"), { recursive: true });
  fs.writeFileSync(path.join(repo, "skill", "SKILL.md"), "NEW");
  fs.mkdirSync(path.join(repo, "merge", "commands"), { recursive: true });
  fs.writeFileSync(path.join(repo, "merge", "commands", "owned.md"), "NEW OWNED");
  fs.writeFileSync(path.join(repo, "merge", "commands", "foreign.md"), "MODULE FOREIGN");
  fs.mkdirSync(path.join(f.installDir, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(f.installDir, "skills", "demo", "SKILL.md"), "OLD");
  fs.mkdirSync(path.join(f.installDir, "commands"), { recursive: true });
  fs.writeFileSync(path.join(f.installDir, "commands", "owned.md"), "OLD OWNED");
  fs.writeFileSync(path.join(f.installDir, "commands", "foreign.md"), "USER");
  upsertModuleStatus(f.installDir, { module: "demo", merge_dir_files: ["commands/owned.md"] });
  const config = { modules: { demo: { operations: [
    { type: "copy_dir", source: "skill", target: "skills/demo" },
    { type: "merge_dir", source: "merge" },
  ] } } };
  await applyModule("demo", config, repo, f.installDir, true, null, null, false);
  assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "demo", "SKILL.md"), "utf8"), "NEW");
  assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "owned.md"), "utf8"), "NEW OWNED");
  assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "foreign.md"), "utf8"), "USER");
});

test("uninstall removes tagged models agents and preserves edited and user agents", async (t) => {
  const f = fixture(t);
  const edited = { model: "original", __module__: "demo" };
  edited.__hash__ = agentDefaultsHash(edited); edited.model = "user";
  const models = modelsFixture(t, {
    owned: { model: "default", __module__: "demo" }, edited,
    user: { model: "mine" }, other: { model: "x", __module__: "other" },
  });
  await uninstallModule("demo", { modules: { demo: { operations: [] } } }, f.installDir, f.installDir, false);
  const agents = JSON.parse(fs.readFileSync(models.modelsPath, "utf8")).agents;
  assert.deepEqual(Object.keys(agents).sort(), ["edited", "other", "user"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(models.modelsPath).mode & 0o777, 0o600);
});

test("update continues all modules after wrapper failure and reports a summary", async (t) => {
  const f = fixture(t);
  const config = { modules: {
    do: { operations: [{ type: "run_command", command: "bash install.sh" }] },
    later: { operations: [] },
  } };
  for (const module of Object.keys(config.modules)) upsertModuleStatus(f.installDir, { module, status: "success" });
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(cliPath), require,
    process: { platform: process.platform, env: {}, stdout: { write() {} } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
    runInstallSh = async () => { throw new Error("close codeagent-wrapper.exe"); };
    const realApply = applyModule;
    applyModule = async (...args) => { module.exports.calls.push(args[0]); return realApply(...args); };
    module.exports.calls = [];
    module.exports.update = updateInstalledModules;
  `, sandbox);
  await assert.rejects(sandbox.module.exports.update(f.installDir, null, config, false), /Update failures:.*\ncodeagent-wrapper: close codeagent-wrapper.exe/);
  assert.deepEqual(Array.from(sandbox.module.exports.calls), ["do", "later"]);
  assert.equal(loadInstalledStatus(f.installDir).modules.later.status, "success");
});

test("install.bat PowerShell invocations contain no exclamation marks", () => {
  const script = fs.readFileSync(path.resolve(__dirname, "../install.bat"), "utf8");
  const lines = script.split(/\r?\n/).filter((line) => /\bpowershell\s+.*-Command\b/i.test(line));
  assert.ok(lines.length > 0, "Expected PowerShell command invocations");
  for (const line of lines) assert.equal(line.includes("!"), false, line);
});

for (const scenario of ["valid", "mismatch", "missing", "unlisted"]) {
  test(`install.bat checksum verification through cmd.exe: ${scenario}`, async (t) => {
    if (process.platform !== "win32") return t.skip("Windows cmd.exe and PowerShell");
    const f = fixture(t);
    const binary = path.join(f.installDir, "wrapper.exe");
    fs.writeFileSync(binary, "local binary bytes");
    const hash = crypto.createHash("sha256").update("local binary bytes").digest("hex");
    const script = fs.readFileSync(path.resolve(__dirname, "../install.bat"), "utf8");
    const label = script.match(/^:verify_checksum\r?\n[\s\S]*?^exit \/b %errorlevel%[^\S\r\n]*(?:\r?\n|$)/m);
    assert.ok(label, "Expected the complete verify_checksum label");
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url !== "/release/SHA256SUMS" || scenario === "missing") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": scenario === "valid" ? "application/octet-stream" : "text/plain" });
      res.end(`${scenario === "mismatch" ? "0".repeat(64) : hash}  ${scenario === "unlisted" ? "other.exe" : "wrapper.exe"}\n`);
    });
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const harness = path.join(f.installDir, "checksum.bat");
    fs.writeFileSync(harness, [
      "@echo off", "setlocal enabledelayedexpansion",
      `set "URL=http://127.0.0.1:${server.address().port}/release/wrapper.exe"`,
      `set "TEMP_FILE=${binary}"`, 'set "BINARY_NAME=wrapper.exe"',
      "call :verify_checksum", "exit /b !errorlevel!", "",
    ].join("\r\n") + label[0]);
    // Keep the event loop free so the local HTTP server can serve PowerShell.
    const result = await new Promise((resolve, reject) => {
      execFile("cmd.exe", ["/d", "/s", "/c", `""${harness}""`], {
        encoding: "utf8", timeout: 30000, windowsHide: true, windowsVerbatimArguments: true,
        cwd: f.installDir,
        env: { ...process.env, HOME: f.installDir, USERPROFILE: f.installDir, TEMP: f.installDir, TMP: f.installDir },
      }, (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) return reject(error);
        resolve({ status: error ? error.code : 0, stdout, stderr });
      });
    });
    assert.equal(result.status, ["valid", "missing"].includes(scenario) ? 0 : 1, result.stdout + result.stderr);
    if (scenario === "missing") assert.match(result.stdout, /SHA256SUMS absent/);
    if (["mismatch", "unlisted"].includes(scenario)) assert.match(result.stdout + result.stderr, /checksum mismatch/);
    assert.deepEqual(requests, ["/release/SHA256SUMS"]);
  });
}

test("install.bat replaces a running executable by renaming the old image", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows executable locking");
  const f = fixture(t);
  const dest = path.join(f.installDir, "codeagent-wrapper.exe");
  const incoming = path.join(f.installDir, "incoming.exe");
  fs.copyFileSync(process.execPath, dest);
  fs.writeFileSync(incoming, "replacement");
  fs.writeFileSync(dest + ".old", "stale");
  const child = require("node:child_process").spawn(dest, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true,
    env: { ...process.env, HOME: f.installDir, USERPROFILE: f.installDir } });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  try {
    const bat = fs.readFileSync(path.resolve(__dirname, "../install.bat"), "utf8");
    const start = bat.indexOf("rem A running executable");
    const end = bat.indexOf('"%DEST%" --version', start);
    const harness = path.join(f.installDir, "replace.bat");
    fs.writeFileSync(harness, "@echo off\r\n" + bat.slice(start, end).replace(/\r?\n/g, "\r\n") + "exit /b 0\r\n:fail\r\nexit /b 1\r\n");
    const result = spawnSync("cmd.exe", ["/d", "/c", harness], { encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env, HOME: f.installDir, USERPROFILE: f.installDir, DEST: dest, TEMP_FILE: incoming } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(dest, "utf8"), "replacement");
    assert.ok(fs.statSync(dest + ".old").size > 1000);
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
});

test("installer tests never modify the real home models.json", () => {
  if (!originalModelsSnapshot) {
    assert.equal(fs.existsSync(originalModelsPath), false);
    return;
  }
  assert.equal(fs.existsSync(originalModelsPath), true);
  const stat = fs.statSync(originalModelsPath);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(originalModelsPath)).digest("hex");
  assert.equal(hash, originalModelsSnapshot.hash);
  assert.equal(stat.mtimeMs, originalModelsSnapshot.mtimeMs);
});


const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

for (const name of ["demo", "skill:solo"]) {
  test(`partial uninstall of ${name} skips updates, labels menus, and permits normal install`, async (t) => {
    const f = fixture(t);
    const repo = path.join(f.installDir, "repo");
    fs.mkdirSync(path.join(repo, "skills", "solo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "skills", "solo", "SKILL.md"), "release");
    const config = { modules: { demo: { operations: [
      { type: "copy_dir", source: "skills/solo", target: "skills/solo" },
    ] } } };
    const retained = { module: name, status: "partial_uninstall", version: "v1", files: { "skills/solo/SKILL.md": sha256("release") } };
    fs.mkdirSync(path.join(f.installDir, "skills", "solo"), { recursive: true });
    fs.writeFileSync(path.join(f.installDir, "skills", "solo", "SKILL.md"), "user edit");
    upsertModuleStatus(f.installDir, retained);
    let output = "";
    const sandbox = {
      module: { exports: {} }, __dirname: path.join(repo, "bin"), require,
      process: { platform: process.platform, env: { ...process.env }, cwd: () => process.cwd(),
        stdout: { write(s) { output += s; } }, stderr: { write() {} } },
    };
    vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
      repoRootFromHere = () => ${JSON.stringify(repo)};
      readLocalConfig = () => (${JSON.stringify(config)});
      listLocalSkills = () => ["solo"];
      promptMultiSelect = async (items) => { module.exports.items = items; return []; };
      module.exports.main = main;
      module.exports.install = installSelected;
    `, sandbox);
    async function run(...args) {
      output = "";
      sandbox.process.argv = ["node", cliPath, "--offline", "--install-dir", f.installDir, ...args];
      await sandbox.module.exports.main();
      return output;
    }
    for (const args of [["--update"], ["--module", name, "--update"]]) {
      const before = fs.readFileSync(path.join(f.installDir, "installed_modules.json"));
      assert.ok((await run(...args)).includes(`${name} is not installed; run without --update to install it`));
      assert.deepEqual(fs.readFileSync(path.join(f.installDir, "installed_modules.json")), before);
      assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "solo", "SKILL.md"), "utf8"), "user edit");
    }
    const id = name.startsWith("skill:") ? name : `module:${name}`;
    assert.ok((await run("--list")).includes(`${id} (partially uninstalled, v1)`));
    await run();
    assert.ok(sandbox.module.exports.items.find(item => item.id === id).label.endsWith(" [partially uninstalled v1]"));
    // Normal install replaces the retained status, using the existing install path.
    const pick = name.startsWith("skill:") ? { kind: "skill", skillName: "solo" } : { kind: "module", moduleName: name };
    await sandbox.module.exports.install([pick], null, config, f.installDir, true, false, true);
    assert.ok(["installed", "success"].includes(loadInstalledStatus(f.installDir).modules[name].status));
    assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "solo", "SKILL.md"), "utf8"), "release");
  });
}

for (const kind of ["module", "standalone skill"]) {
  test(`${kind} records written hashes and uninstalls across source versions with retryable partial status`, async (t) => {
    const f = fixture(t);
    const repo = path.join(f.installDir, "repo");
    const source = path.join(repo, "skills", "solo");
    fs.mkdirSync(path.join(source, "obsolete"), { recursive: true });
    const originals = {
      "SKILL.md": Buffer.from([0, 255, 13, 10]),
      "obsolete/removed.md": Buffer.from("removed upstream"),
      "edited.md": Buffer.from("installed original"),
    };
    for (const [rel, bytes] of Object.entries(originals)) fs.writeFileSync(path.join(source, rel), bytes);
    fs.writeFileSync(path.join(source, "skipped.md"), "source");
    fs.mkdirSync(path.join(f.installDir, "skills", "solo"), { recursive: true });
    fs.writeFileSync(path.join(f.installDir, "skills", "solo", "skipped.md"), "user existing");
    fs.writeFileSync(path.join(repo, "agent.md"), "old agent");
    const config = { modules: { demo: { operations: [
      { type: "copy_dir", source: "skills/solo", target: "skills/solo" },
      { type: "copy_file", source: "agent.md", target: "agents/demo.md" },
    ] } } };
    const name = kind === "module" ? "demo" : "skill:solo";
    const sandbox = {
      module: { exports: {} }, __dirname: path.join(repo, "bin"), require,
      process: { platform: process.platform, env: { ...process.env }, stdout: { write() {} }, stderr: { write() {} } },
    };
    vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
      repoRootFromHere = () => ${JSON.stringify(repo)};
      module.exports.install = installSelected;
    `, sandbox);
    if (kind === "module") {
      upsertModuleStatus(f.installDir, await applyModule(name, config, repo, f.installDir, false));
    } else {
      await sandbox.module.exports.install([{ kind: "skill", skillName: "solo" }], null, {}, f.installDir, false, false, true);
    }
    const expected = Object.fromEntries(Object.entries(originals).map(([rel, bytes]) => [`skills/solo/${rel}`, sha256(bytes)]));
    if (kind === "module") expected["agents/demo.md"] = sha256("old agent");
    assert.deepEqual(loadInstalledStatus(f.installDir).modules[name].files, expected);

    fs.writeFileSync(path.join(source, "SKILL.md"), "new release");
    fs.unlinkSync(path.join(source, "obsolete", "removed.md"));
    fs.writeFileSync(path.join(repo, "agent.md"), "new agent");
    // A skipped file remains outside this regression's ownership checks.
    fs.unlinkSync(path.join(source, "skipped.md"));
    fs.writeFileSync(path.join(f.installDir, "skills", "solo", "edited.md"), "user edit");
    const statusPath = path.join(f.installDir, "installed_modules.json");
    const before = fs.readFileSync(statusPath);
    let dryOutput = "";
    let realOutput = "";
    const write = process.stdout.write;
    try {
      process.stdout.write = (value) => { dryOutput += value; return true; };
      await uninstallModule(name, config, repo, f.installDir, true);
      assert.deepEqual(fs.readFileSync(statusPath), before);
      for (const [rel, bytes] of Object.entries(originals)) {
        assert.deepEqual(fs.readFileSync(path.join(f.installDir, "skills", "solo", rel)),
          rel === "edited.md" ? Buffer.from("user edit") : bytes);
      }
      if (kind === "module") assert.equal(fs.readFileSync(path.join(f.installDir, "agents", "demo.md"), "utf8"), "old agent");
      process.stdout.write = (value) => { realOutput += value; return true; };
      await uninstallModule(name, config, repo, f.installDir, false);
    } finally { process.stdout.write = write; }
    assert.equal(realOutput, dryOutput.replace(/- remove .*\n/g, ""));
    assert.match(realOutput, /Keeping .*edited.md: differs from the installed copy/);
    assert.match(realOutput, /partially uninstalled; remaining files: skills\/solo\/edited.md/);
    assert.equal(fs.existsSync(path.join(f.installDir, "skills", "solo", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(f.installDir, "skills", "solo", "obsolete")), false);
    if (kind === "module") assert.equal(fs.existsSync(path.join(f.installDir, "agents", "demo.md")), false);
    assert.deepEqual(loadInstalledStatus(f.installDir).modules[name].files, {
      "skills/solo/edited.md": sha256("installed original"),
    });
    const previous = JSON.parse(before).modules[name];
    assert.deepEqual(loadInstalledStatus(f.installDir).modules[name], {
      ...previous, status: "partial_uninstall", files: { "skills/solo/edited.md": sha256("installed original") },
    });
    assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "solo", "skipped.md"), "utf8"), "user existing");
    // The retained install hash makes retry independent of another release change.
    fs.rmSync(source, { recursive: true });
    fs.writeFileSync(path.join(f.installDir, "skills", "solo", "edited.md"), "installed original");
    sandbox.process.argv = ["node", cliPath, "uninstall", "--module", name, "--install-dir", f.installDir, "--yes"];
    sandbox.process.cwd = () => process.cwd();
    vm.runInNewContext(`readLocalConfig = () => (${JSON.stringify(config)}); module.exports.main = main;`, sandbox);
    await sandbox.module.exports.main();
    assert.equal(loadInstalledStatus(f.installDir).modules[name], undefined);
    assert.equal(fs.existsSync(path.join(f.installDir, "skills", "solo", "edited.md")), false);
  });
}

test("legacy copy entries retain source comparison and update refreshes hashes", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "payload"), { recursive: true });
  fs.writeFileSync(path.join(repo, "payload", "SKILL.md"), "release B");
  fs.writeFileSync(path.join(repo, "agent.md"), "release B agent");
  const config = { modules: { demo: { operations: [
    { type: "copy_dir", source: "payload", target: "skills/demo" },
    { type: "copy_file", source: "agent.md", target: "agents/demo.md" },
  ] } } };
  fs.mkdirSync(path.join(f.installDir, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(f.installDir, "agents"));
  fs.writeFileSync(path.join(f.installDir, "skills", "demo", "SKILL.md"), "release A");
  fs.writeFileSync(path.join(f.installDir, "agents", "demo.md"), "release B agent");
  upsertModuleStatus(f.installDir, { module: "demo", status: "success" });
  assert.deepEqual(readInstalledModuleNamesFromStatus(f.installDir), ["demo"]);
  await uninstallModule("demo", config, repo, f.installDir, false);
  assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "demo", "SKILL.md"), "utf8"), "release A");
  assert.equal(fs.existsSync(path.join(f.installDir, "agents", "demo.md")), false);
  assert.deepEqual(loadInstalledStatus(f.installDir).modules.demo.files, { "skills/demo/SKILL.md": sha256("release B") });
  const sandbox = {
    module: { exports: {} }, __dirname: path.join(repo, "bin"), require,
    process: { platform: process.platform, env: { ...process.env }, stdout: { write() {} } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
    repoRootFromHere = () => ${JSON.stringify(repo)};
    module.exports.update = updateInstalledModules;
  `, sandbox);
  for (const legacy of [true, false]) {
    if (legacy) upsertModuleStatus(f.installDir, { module: "demo", status: "success" });
    else fs.writeFileSync(path.join(repo, "payload", "SKILL.md"), "release C");
    await sandbox.module.exports.update(f.installDir, null, config, false, false, true);
    assert.deepEqual(loadInstalledStatus(f.installDir).modules.demo.files, {
      "skills/demo/SKILL.md": sha256(legacy ? "release B" : "release C"),
      "agents/demo.md": sha256("release B agent"),
    });
  }
});

// Requirement regressions use only fixture directories and stub wrapper downloads.
function requirementSandbox(repo, home = repo) {
  let output = "";
  let warnings = "";
  const sandbox = {
    module: { exports: {} }, __dirname: path.join(repo, "bin"),
    require: (name) => name === "os" ? { ...os, homedir: () => home } : require(name),
    process: { platform: process.platform, env: { ...process.env },
      stdout: { write(value) { output += value; } }, stderr: { write(value) { warnings += value; } } },
  };
  vm.runInNewContext(fs.readFileSync(cliPath, "utf8") + `
    repoRootFromHere = () => ${JSON.stringify(repo)};
    let wrapperCalls = 0;
    runInstallSh = async () => { wrapperCalls++; };
    module.exports.install = installSelected;
    module.exports.update = updateInstalledModules;
    module.exports.uninstallModule = uninstallModule;
    module.exports.wrapperCalls = () => wrapperCalls;
  `, sandbox);
  return { api: sandbox.module.exports, output: () => output, warnings: () => warnings };
}

test("batch 10 merge_dir excludes plugin manifests and config writes do not overlap", async (t) => {
  const f = fixture(t);
  const repo = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(repo, "config.json"), "utf8"));
  const s = requirementSandbox(repo);
  await s.api.install([
    { kind: "module", moduleName: "essentials" },
    { kind: "module", moduleName: "requirements" },
  ], null, config, f.installDir, false, false, true);
  await s.api.install([
    { kind: "module", moduleName: "essentials" },
    { kind: "module", moduleName: "requirements" },
  ], null, config, f.installDir, true, false, true);
  assert.equal(fs.existsSync(path.join(f.installDir, ".claude-plugin")), false);
  const status = loadInstalledStatus(f.installDir);
  for (const entry of Object.values(status.modules)) {
    assert.equal(Object.hasOwn(entry.files || {}, ".claude-plugin/plugin.json"), false);
    assert.equal((entry.merge_dir_files || []).includes(".claude-plugin/plugin.json"), false);
  }

  const writers = new Map();
  for (const [name, mod] of Object.entries(config.modules)) {
    for (const op of mod.operations || []) {
      if (op.type === "copy_file") add(op.target, name);
      else if (op.type === "copy_dir") {
        const walk = (dir, rel = "") => {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const child = path.join(dir, ent.name);
            const target = path.posix.join(op.target.replace(/\\/g, "/"), rel.replace(/\\/g, "/"), ent.name);
            if (ent.isDirectory()) walk(child, path.join(rel, ent.name));
            else if (ent.isFile()) add(target, name);
          }
        };
        walk(path.join(repo, op.source));
      } else if (op.type === "merge_dir") {
        for (const dir of fs.readdirSync(path.join(repo, op.source), { withFileTypes: true })) {
          if (!dir.isDirectory() || dir.name === ".claude-plugin") continue;
          for (const file of fs.readdirSync(path.join(repo, op.source, dir.name), { withFileTypes: true })) {
            if (file.isFile()) add(path.posix.join(dir.name, file.name), name);
          }
        }
      }
    }
  }
  function add(rel, name) {
    const key = rel.replace(/\\/g, "/");
    if (!writers.has(key)) writers.set(key, new Set());
    writers.get(key).add(name);
  }
  const allowlist = {};
  const overlaps = [...writers].filter(([rel, names]) => names.size > 1 && !allowlist[rel]);
  assert.deepEqual(overlaps, []);
});

test("batch 10 update migrates legacy plugin manifest ownership", async (t) => {
  const f = fixture(t);
  const repo = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(repo, "config.json"), "utf8"));
  const rel = ".claude-plugin/plugin.json";
  const requirements = fs.readFileSync(path.join(repo, "agents/requirements", rel));
  const essentials = fs.readFileSync(path.join(repo, "agents/development-essentials", rel));
  const target = path.join(f.installDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, requirements);
  upsertModuleStatus(f.installDir, { module: "essentials", status: "success", files: { [rel]: sha256(essentials) }, merge_dir_files: [rel] });
  upsertModuleStatus(f.installDir, { module: "requirements", status: "success", files: { [rel]: sha256(requirements) }, merge_dir_files: [rel] });
  const s = requirementSandbox(repo);
  await s.api.update(f.installDir, null, config, false, false, true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.dirname(target)), false);
  for (const entry of Object.values(loadInstalledStatus(f.installDir).modules)) {
    assert.equal(Object.hasOwn(entry.files || {}, rel), false);
    assert.equal((entry.merge_dir_files || []).includes(rel), false);
  }
  assert.doesNotMatch(s.output(), /Keeping .*plugin\.json: modified locally/);
});

test("batch 10 update keeps edited plugin manifest once and uninstall drops legacy ownership", async (t) => {
  const f = fixture(t);
  const repo = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(repo, "config.json"), "utf8"));
  const rel = ".claude-plugin/plugin.json";
  const target = path.join(f.installDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "user edit");
  upsertModuleStatus(f.installDir, { module: "essentials", status: "success", files: { [rel]: sha256("old") }, merge_dir_files: [rel] });
  upsertModuleStatus(f.installDir, { module: "requirements", status: "success", files: { [rel]: sha256("old") }, merge_dir_files: [rel] });
  const s = requirementSandbox(repo);
  await s.api.update(f.installDir, null, config, false, false, true);
  assert.equal(fs.readFileSync(target, "utf8"), "user edit");
  assert.equal((s.output().match(/Keeping .*plugin\.json: modified locally/g) || []).length, 1);
  for (const entry of Object.values(loadInstalledStatus(f.installDir).modules)) {
    assert.equal(Object.hasOwn(entry.files || {}, rel), false);
    assert.equal((entry.merge_dir_files || []).includes(rel), false);
  }

  const f2 = fixture(t);
  fs.mkdirSync(path.dirname(path.join(f2.installDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(f2.installDir, rel), fs.readFileSync(path.join(repo, "agents/requirements", rel)));
  upsertModuleStatus(f2.installDir, { module: "essentials", status: "success", files: { [rel]: sha256("other") }, merge_dir_files: [rel] });
  upsertModuleStatus(f2.installDir, { module: "requirements", status: "success", files: { [rel]: sha256("other") }, merge_dir_files: [rel] });
  const uninstall = requirementSandbox(repo);
  await uninstall.api.uninstallModule("essentials", config, repo, f2.installDir, false);
  await uninstall.api.uninstallModule("requirements", config, repo, f2.installDir, false);
  assert.equal(fs.existsSync(path.join(f2.installDir, rel)), false);
  assert.deepEqual(loadInstalledStatus(f2.installDir).modules, {});
});

for (const type of ["copy_file", "copy_dir", "merge_dir"]) {
  test(`I1/I2 ${type}: repeated reinstall, retired ownership, local edits and force`, async (t) => {
    const f = fixture(t);
    const repo = path.join(f.installDir, "repo");
    const source = type === "merge_dir" ? "source/commands" : "source";
    fs.mkdirSync(path.join(repo, source), { recursive: true });
    const targetDir = type === "merge_dir" ? "commands" : "skills/demo";
    const rel = `${targetDir}/owned.md`;
    fs.writeFileSync(path.join(repo, source, "owned.md"), "v1");
    const op = type === "copy_file" ? { type, source: "source/owned.md", target: rel } :
      { type, source: "source", ...(type === "copy_dir" ? { target: targetDir } : {}) };
    const config = { modules: { demo: { operations: [op] } } };
    async function install(force = false, explicit = force) {
      const result = await applyModule("demo", config, repo, f.installDir, force, null, {}, explicit);
      upsertModuleStatus(f.installDir, result);
      return result;
    }
    const first = await install();
    assert.equal(first.files[rel], sha256("v1"));
    for (let i = 0; i < 2; i++) assert.deepEqual((await install()).files, first.files);
    fs.writeFileSync(path.join(f.installDir, rel), "user edit");
    fs.writeFileSync(path.join(repo, source, "owned.md"), "v2");
    let output = "";
    const write = process.stdout.write;
    process.stdout.write = value => { output += value; return true; };
    let kept;
    try { kept = await install(true, false); } finally { process.stdout.write = write; }
    assert.match(output, /Keeping .*owned.md: modified locally \(use --force to overwrite\)/);
    assert.equal(fs.readFileSync(path.join(f.installDir, rel), "utf8"), "user edit");
    assert.equal(kept.files[rel], first.files[rel]);
    assert.equal((await install(true, true)).files[rel], sha256("v2"));
    fs.unlinkSync(path.join(repo, source, "owned.md"));
    if (type === "copy_file") config.modules.demo.operations = [];
    assert.equal((await install(true, false)).files[rel], sha256("v2"));
    await uninstallModule("demo", config, repo, f.installDir, false);
    assert.equal(fs.existsSync(path.join(f.installDir, rel)), false);
  });
}

for (const type of ["copy_file", "copy_dir", "merge_dir"]) {
  test(`I1 ${type}: unrecorded identical user file is never deleted`, async (t) => {
    const f = fixture(t);
    const repo = path.join(f.installDir, "repo");
    fs.mkdirSync(path.join(repo, "source", "commands"), { recursive: true });
    fs.mkdirSync(path.join(f.installDir, "commands"));
    fs.writeFileSync(path.join(repo, "source", "commands", "user.md"), "same");
    fs.writeFileSync(path.join(f.installDir, "commands", "user.md"), "same");
    const op = type === "copy_file" ? { type, source: "source/commands/user.md", target: "commands/user.md" } :
      { type, source: type === "copy_dir" ? "source/commands" : "source", target: "commands" };
    const config = { modules: { demo: { operations: [op] } } };
    upsertModuleStatus(f.installDir, { module: "demo", files: {}, merge_dir_files: [] });
    await uninstallModule("demo", config, repo, f.installDir, false);
    assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "user.md"), "utf8"), "same");
  });
}

test("I1 merge_dir hashes allow partial uninstall and retry after upstream removal", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "source", "commands"), { recursive: true });
  for (const name of ["clean", "edited"]) fs.writeFileSync(path.join(repo, "source", "commands", name), name);
  const config = { modules: { demo: { operations: [{ type: "merge_dir", source: "source" }] } } };
  upsertModuleStatus(f.installDir, await applyModule("demo", config, repo, f.installDir, false));
  fs.writeFileSync(path.join(f.installDir, "commands", "edited"), "user");
  fs.rmSync(path.join(repo, "source"), { recursive: true });
  await uninstallModule("demo", config, repo, f.installDir, false);
  const entry = loadInstalledStatus(f.installDir).modules.demo;
  assert.equal(entry.status, "partial_uninstall");
  assert.deepEqual(entry.files, { "commands/edited": sha256("edited") });
  assert.deepEqual(entry.merge_dir_files, ["commands/edited"]);
  assert.equal(fs.existsSync(path.join(f.installDir, "commands", "clean")), false);
  fs.writeFileSync(path.join(f.installDir, "commands", "edited"), "edited");
  await uninstallModule("demo", config, repo, f.installDir, false);
  assert.equal(loadInstalledStatus(f.installDir).modules.demo, undefined);
});

for (const ownership of ["files", "merge_dir_files", "copy_dir", "copy_file"]) {
  for (const status of ["installed", "success", "partial_uninstall"]) {
    test(`I3 course uninstall keeps skill:dev shared via ${ownership}, ${status}`, async (t) => {
      const f = fixture(t);
      const rel = "skills/dev/SKILL.md";
      fs.mkdirSync(path.dirname(path.join(f.installDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(f.installDir, rel), "dev");
      upsertModuleStatus(f.installDir, { module: "course", files: { [rel]: sha256("dev") }, status: "success" });
      const other = { module: ownership.startsWith("copy_") ? "other" : "skill:dev", status };
      if (ownership === "files") other.files = { [rel]: sha256("dev") };
      if (ownership === "merge_dir_files") other.merge_dir_files = [rel];
      upsertModuleStatus(f.installDir, other);
      const config = { modules: { course: { operations: [] }, other: { operations: [
        { type: ownership, target: ownership === "copy_dir" ? "skills/dev" : rel },
      ] } } };
      await uninstallModule("course", config, f.installDir, f.installDir, false);
      assert.equal(fs.readFileSync(path.join(f.installDir, rel), "utf8"), "dev");
      assert.equal(loadInstalledStatus(f.installDir).modules.course, undefined);
    });
  }
}

test("I4 standalone codeagent and --with-claude-md ensure wrapper (stubbed)", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "skills", "codeagent"), { recursive: true });
  fs.mkdirSync(path.join(repo, "memorys"));
  fs.writeFileSync(path.join(repo, "skills", "codeagent", "SKILL.md"), "wrapper");
  fs.writeFileSync(path.join(repo, "memorys", "CLAUDE.md"), "workflow");
  const s = requirementSandbox(repo);
  await s.api.install([{ kind: "skill", skillName: "codeagent" }], null, {}, f.installDir, false, false);
  assert.equal(s.api.wrapperCalls(), 1);
  await s.api.update(f.installDir, null, { modules: {} }, false, false, true);
  assert.equal(s.api.wrapperCalls(), 2);
  await s.api.install([], null, {}, f.installDir, false, false, false, true);
  assert.equal(s.api.wrapperCalls(), 3);
  assert.equal(fs.readFileSync(path.join(f.installDir, "CLAUDE.md"), "utf8"), "workflow");
});

test("I5 rejects non-canonical ownership keys even when they normalize to a source target", async (t) => {
  const f = fixture(t);
  const s = requirementSandbox(path.join(f.installDir, "repo"));
  fs.mkdirSync(path.join(f.installDir, "commands"));
  fs.writeFileSync(path.join(f.installDir, "commands", "safe"), "safe");
  const keys = ["commands/./safe", "commands/x/../safe", "commands//safe", "commands\\safe",
    "/commands/safe", "C:/commands/safe", "//server/share/safe", "../safe"];
  upsertModuleStatus(f.installDir, { module: "demo", files: Object.fromEntries(keys.map(k => [k, sha256("safe")])) });
  await s.api.uninstallModule("demo", { modules: { demo: { operations: [{ type: "copy_file", target: "commands/safe" }] } } }, f.installDir, f.installDir, false);
  assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "safe"), "utf8"), "safe");
  for (const key of keys) assert.ok(s.warnings().includes(key), key);
});

test("I5 uninstall keeps files behind a junction or symlink escaping installDir", async (t) => {
  const f = fixture(t);
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "myclaude-outside-"));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  fs.writeFileSync(path.join(external, "safe"), "safe");
  const link = path.join(f.installDir, "linked");
  try { fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (err) { t.skip(`OS cannot create a directory link: ${err.message}`); return; }
  const s = requirementSandbox(path.join(f.installDir, "repo"));
  upsertModuleStatus(f.installDir, { module: "demo", files: { "linked/safe": sha256("safe") } });
  await s.api.uninstallModule("demo", { modules: { demo: { operations: [] } } }, f.installDir, f.installDir, false);
  assert.equal(fs.readFileSync(path.join(external, "safe"), "utf8"), "safe");
  assert.match(s.warnings(), /parent escapes install directory/);
  assert.equal(loadInstalledStatus(f.installDir).modules.demo.status, "partial_uninstall");
});

test("I6 identical unmarked user hook survives merge, reinstall, and uninstall", (t) => {
  const hook = { matcher: "*", hooks: [{ type: "command", command: "echo user" }] };
  const f = fixture(t, { hooks: { Stop: [hook] } });
  for (let i = 0; i < 2; i++) mergeHooksToSettings("demo", { hooks: { Stop: [hook] } }, f.installDir);
  assert.deepEqual(f.read().hooks.Stop, [hook]);
  unmergeHooksFromSettings("demo", f.installDir);
  assert.deepEqual(f.read().hooks.Stop, [hook]);
});

test("I7 legacy merge_dir update reports count and force takeover instruction", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "source", "commands"), { recursive: true });
  fs.mkdirSync(path.join(f.installDir, "commands"));
  for (const name of ["one", "two"]) {
    fs.writeFileSync(path.join(repo, "source", "commands", name), "upstream");
    fs.writeFileSync(path.join(f.installDir, "commands", name), "foreign");
  }
  upsertModuleStatus(f.installDir, { module: "demo", status: "success" });
  const s = requirementSandbox(repo);
  await s.api.update(f.installDir, null, { modules: { demo: { operations: [{ type: "merge_dir", source: "source" }] } } }, false, false, true);
  assert.match(s.output(), /Module demo: skipped 2 foreign merge_dir file\(s\); use --force to take them over/);
});

test("I8 relocated prompt_file applies only to module defaults; default home keeps tilde", (t) => {
  const f = fixture(t);
  const s = requirementSandbox(path.join(f.installDir, "repo"), f.installDir);
  const modelPath = path.join(f.installDir, ".codeagent", "models.json");
  const mod = { agents: { owned: { prompt_file: "~/.claude/skills/omo/references/x.md" },
    custom: { prompt_file: "~/.claude/skills/omo/references/x.md" } } };
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  fs.writeFileSync(modelPath, JSON.stringify({ agents: { custom: { prompt_file: "custom.md" } } }));
  const relocated = path.join(f.installDir, "relocated");
  s.api.mergeModuleAgentsToModels("omo", mod, f.installDir, relocated);
  let models = JSON.parse(fs.readFileSync(modelPath));
  assert.equal(models.agents.owned.prompt_file, path.join(relocated, "skills/omo/references/x.md").replace(/\\/g, "/"));
  assert.equal(models.agents.custom.prompt_file, "custom.md");
  assert.equal(models.agents.owned.__hash__, agentDefaultsHash(models.agents.owned));
  s.api.mergeModuleAgentsToModels("omo", mod, f.installDir, path.join(f.installDir, ".claude"));
  models = JSON.parse(fs.readFileSync(modelPath));
  assert.equal(models.agents.owned.prompt_file, "~/.claude/skills/omo/references/x.md");
});

test("I1/I2 standalone skill reinstall and update retain ownership and protect local edits", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  const source = path.join(repo, "skills", "solo");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "v1");
  fs.writeFileSync(path.join(source, "retired.md"), "retired");
  const s = requirementSandbox(repo);
  const pick = [{ kind: "skill", skillName: "solo" }];
  const config = { modules: {} };
  for (let i = 0; i < 3; i++) {
    await s.api.install(pick, null, config, f.installDir, false, false, true);
    assert.deepEqual(loadInstalledStatus(f.installDir).modules["skill:solo"].files, {
      "skills/solo/SKILL.md": sha256("v1"), "skills/solo/retired.md": sha256("retired"),
    });
  }
  fs.writeFileSync(path.join(f.installDir, "skills", "solo", "SKILL.md"), "user");
  fs.writeFileSync(path.join(source, "SKILL.md"), "v2");
  fs.unlinkSync(path.join(source, "retired.md"));
  await s.api.update(f.installDir, null, config, false, false, true);
  assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "solo", "SKILL.md"), "utf8"), "user");
  assert.match(s.output(), /Keeping .*SKILL.md: modified locally \(use --force to overwrite\)/);
  assert.equal(loadInstalledStatus(f.installDir).modules["skill:solo"].files["skills/solo/SKILL.md"], sha256("v1"));
  await s.api.update(f.installDir, null, config, false, true, true);
  assert.equal(fs.readFileSync(path.join(f.installDir, "skills", "solo", "SKILL.md"), "utf8"), "v2");
  await s.api.uninstallModule("skill:solo", config, repo, f.installDir, false);
  assert.equal(fs.existsSync(path.join(f.installDir, "skills", "solo")), false);
});

test("I2 merge_dir respects a files hash even without a legacy merge_dir_files list", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "source", "commands"), { recursive: true });
  fs.mkdirSync(path.join(f.installDir, "commands"));
  fs.writeFileSync(path.join(repo, "source", "commands", "demo"), "v2");
  fs.writeFileSync(path.join(f.installDir, "commands", "demo"), "user");
  upsertModuleStatus(f.installDir, { module: "demo", files: { "commands/demo": sha256("v1") } });
  const s = requirementSandbox(repo);
  const r = await s.api.applyModule("demo", { modules: { demo: { operations: [{ type: "merge_dir", source: "source" }] } } }, repo, f.installDir, true, null, {}, false);
  assert.match(s.output(), /Keeping .*demo: modified locally \(use --force to overwrite\)/);
  assert.equal(r.files["commands/demo"], sha256("v1"));
  assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "demo"), "utf8"), "user");
});


test("batch 9 legacy empty files map honors merge_dir ownership and source comparison", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  fs.mkdirSync(path.join(repo, "source", "commands"), { recursive: true });
  fs.mkdirSync(path.join(f.installDir, "commands"));
  for (const name of ["clean", "edited", "foreign"]) {
    fs.writeFileSync(path.join(repo, "source", "commands", name), "original");
    fs.writeFileSync(path.join(f.installDir, "commands", name), name === "edited" ? "user edit" : "original");
  }
  upsertModuleStatus(f.installDir, { module: "demo", status: "success", files: {},
    merge_dir_files: ["commands/clean", "commands/edited"] });
  const s = requirementSandbox(repo);
  await s.api.uninstallModule("demo", { modules: { demo: { operations: [{ type: "merge_dir", source: "source" }] } } }, repo, f.installDir, false);
  assert.equal(fs.existsSync(path.join(f.installDir, "commands", "clean")), false);
  assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "edited"), "utf8"), "user edit");
  assert.equal(fs.readFileSync(path.join(f.installDir, "commands", "foreign"), "utf8"), "original");
  assert.match(s.output(), /Keeping .*edited: differs from the installed copy/);
  assert.deepEqual(loadInstalledStatus(f.installDir).modules.demo.merge_dir_files, ["commands/edited"]);
});

for (const legacy of [false, true]) {
  for (const first of ["course", "skill:dev"]) {
    for (const edited of [false, true]) {
      test(`batch 9 shared dev files: legacy=${legacy}, first=${first}, edited=${edited}`, async (t) => {
        const f = fixture(t);
        const repo = path.join(f.installDir, "repo");
        const rel = "skills/dev/SKILL.md";
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), "dev default");
        const config = { modules: { course: { operations: [
          { type: "copy_dir", source: "skills/dev", target: "skills/dev" },
        ] } } };
        const s = requirementSandbox(repo);
        await s.api.install([{ kind: "module", moduleName: "course" }], null, config, f.installDir, false, false);
        await s.api.install([{ kind: "skill", skillName: "dev" }], null, config, f.installDir, false, false);
        const dev = loadInstalledStatus(f.installDir).modules["skill:dev"];
        if (legacy) upsertModuleStatus(f.installDir, { ...dev, files: {} });
        else assert.equal(dev.files[rel], sha256("dev default"));
        if (edited) fs.writeFileSync(path.join(f.installDir, rel), "user edit");
        const before = fs.readFileSync(path.join(f.installDir, "installed_modules.json"));
        await s.api.uninstallModule(first, config, repo, f.installDir, true);
        assert.deepEqual(fs.readFileSync(path.join(f.installDir, "installed_modules.json")), before);
        await s.api.uninstallModule(first, config, repo, f.installDir, false);
        const last = first === "course" ? "skill:dev" : "course";
        assert.equal(loadInstalledStatus(f.installDir).modules[last].files[rel], sha256("dev default"));
        await s.api.uninstallModule(last, config, repo, f.installDir, false);
        if (edited) {
          assert.equal(fs.readFileSync(path.join(f.installDir, rel), "utf8"), "user edit");
          assert.equal(loadInstalledStatus(f.installDir).modules[last].status, "partial_uninstall");
          fs.writeFileSync(path.join(f.installDir, rel), "dev default");
          await s.api.uninstallModule(last, config, repo, f.installDir, false);
        }
        assert.equal(fs.existsSync(path.join(f.installDir, rel)), false);
        assert.deepEqual(loadInstalledStatus(f.installDir).modules, {});
      });
    }
  }
}

test("batch 9 restored agents retain custom install-dir prompt relocation and hash", async (t) => {
  const f = fixture(t);
  const repo = path.join(f.installDir, "repo");
  const installDir = path.join(f.installDir, "custom");
  const s = requirementSandbox(repo, f.installDir);
  const config = { modules: {
    omo: { agents: { shared: { prompt_file: "~/.claude/skills/omo/default.md" } } },
    do: { agents: { shared: { prompt_file: "~/.claude/skills/do/default.md" } } },
  } };
  for (const name of ["omo", "do"]) {
    upsertModuleStatus(installDir, await s.api.applyModule(name, config, repo, installDir, false));
  }
  const modelsPath = path.join(f.installDir, ".codeagent", "models.json");
  const readAgent = () => JSON.parse(fs.readFileSync(modelsPath)).agents.shared;
  assert.equal(readAgent().__module__, "do");
  await s.api.uninstallModule("do", config, repo, installDir, false);
  const restored = readAgent();
  assert.equal(restored.__module__, "omo");
  assert.equal(restored.prompt_file, path.join(installDir, "skills/omo/default.md").replace(/\\/g, "/"));
  assert.equal(restored.__hash__, agentDefaultsHash(restored));
  await s.api.uninstallModule("omo", config, repo, installDir, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(modelsPath)).agents, {});
});
