#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const readline = require("readline");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");

const REPO = { owner: "miraserver", name: "myclaude" };
const API_HEADERS = {
  "User-Agent": "myclaude-npx",
  Accept: "application/vnd.github+json",
};
const WRAPPER_REQUIRED_MODULES = new Set(["do", "omo", "course"]);
const WRAPPER_REQUIRED_SKILLS = new Set(["dev", "codeagent", "do", "omo"]);

function parseArgs(argv) {
  const out = {
    command: "install",
    installDir: "~/.claude",
    force: false,
    dryRun: false,
    list: false,
    update: false,
    tag: null,
    module: null,
    yes: false,
    offline: false,
    skipWrapper: false,
    withClaudeMd: false,
  };

  let i = 0;
  if (argv[i] && !argv[i].startsWith("-")) {
    out.command = argv[i];
    i++;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install-dir") out.installDir = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--list") out.list = true;
    else if (a === "--update") out.update = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "--skip-wrapper") out.skipWrapper = true;
    else if (a === "--with-claude-md") out.withClaudeMd = true;
    else if (a === "--tag") out.tag = argv[++i];
    else if (a === "--module") out.module = argv[++i];
    else if (a === "-y" || a === "--yes") out.yes = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }

  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "myclaude (npx installer)",
      "",
      "Usage:",
      "  npx github:miraserver/myclaude",
      "  npx github:miraserver/myclaude --list",
      "  npx github:miraserver/myclaude --update",
      "  npx github:miraserver/myclaude --install-dir ~/.claude --force",
      "  npx github:miraserver/myclaude uninstall",
      "  npx github:miraserver/myclaude uninstall --module bmad,do -y",
      "",
      "Options:",
      "  --install-dir <path>   Default: ~/.claude",
      "  --force                Overwrite existing files",
      "  --dry-run              Print actions only",
      "  --list                 List installable items and exit",
      "  --update               Update already installed modules",
      "  --offline              Install/update from local package contents",
      "  --with-claude-md       Install the optional global CLAUDE.md workflow instructions",
      "  --skip-wrapper         Skip codeagent-wrapper install (or MYCLAUDE_SKIP_WRAPPER=1)",
      "  --tag <tag>            Install a specific GitHub tag",
      "  --module <names>       For uninstall: comma-separated module names",
      "  -y, --yes              For uninstall: skip confirmation prompt",
    ].join("\n") + "\n"
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: API_HEADERS }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(
              new Error(`HTTP ${res.statusCode}: ${url}\n${body.slice(0, 500)}`)
            );
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function downloadToFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https
      .get(url, { headers: API_HEADERS }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close();
          fs.unlink(outPath, () => {
            downloadToFile(res.headers.location, outPath).then(resolve, reject);
          });
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          file.close();
          fs.unlink(outPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        file.close();
        fs.unlink(outPath, () => reject(err));
      });
  });
}

async function fetchLatestTag() {
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/releases/latest`;
  const json = await httpsGetJson(url);
  if (!json || typeof json.tag_name !== "string" || !json.tag_name.trim()) {
    throw new Error("GitHub API: missing tag_name");
  }
  return json.tag_name.trim();
}

async function fetchRemoteConfig(tag) {
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/config.json?ref=${encodeURIComponent(
    tag
  )}`;
  const json = await httpsGetJson(url);
  if (!json || typeof json.content !== "string") {
    throw new Error("GitHub contents API: missing config.json content");
  }
  const buf = Buffer.from(json.content.replace(/\n/g, ""), "base64");
  return JSON.parse(buf.toString("utf8"));
}

async function fetchRemoteSkills(tag) {
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/skills?ref=${encodeURIComponent(
    tag
  )}`;
  const json = await httpsGetJson(url);
  if (!Array.isArray(json)) throw new Error("GitHub contents API: skills is not a directory");
  return json
    .filter((e) => e && e.type === "dir" && typeof e.name === "string")
    .map((e) => e.name)
    .sort();
}

function repoRootFromHere() {
  return path.resolve(__dirname, "..");
}

function readLocalConfig() {
  const p = path.join(repoRootFromHere(), "config.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listLocalSkills() {
  const root = repoRootFromHere();
  const skillsDir = path.join(root, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveInstallDir(value, cwd = process.cwd()) {
  return path.resolve(cwd, expandHome(value));
}

function wrapperBinPath(installDir, platform = process.platform, home = os.homedir()) {
  return platform === "win32"
    ? path.win32.join(home, "bin", "codeagent-wrapper.exe")
    : path.join(installDir, "bin", "codeagent-wrapper");
}

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

function validateInstallJson(installDir) {
  for (const filePath of [
    path.join(installDir, "installed_modules.json"),
    path.join(installDir, "settings.json"),
    path.join(os.homedir(), ".codeagent", "models.json"),
  ]) {
    if (fs.existsSync(filePath)) readJsonFile(filePath);
  }
}

function readInstalledModuleNamesFromStatus(installDir) {
  const p = path.join(installDir, "installed_modules.json");
  if (!fs.existsSync(p)) return null;
  const json = readJsonFile(p);
  const modules = json && json.modules;
  if (!modules || typeof modules !== "object" || Array.isArray(modules)) return null;
  return Object.keys(modules)
    .filter((k) => typeof k === "string" && k.trim())
    .sort();
}

function loadInstalledStatus(installDir) {
  const p = path.join(installDir, "installed_modules.json");
  if (!fs.existsSync(p)) return { modules: {} };
  const json = readJsonFile(p);
  const modules = json && json.modules;
  if (!modules || typeof modules !== "object" || Array.isArray(modules)) return { modules: {} };
  return { ...json, modules };
}

function saveInstalledStatus(installDir, status) {
  const p = path.join(installDir, "installed_modules.json");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(status, null, 2) + "\n", "utf8");
}

function upsertModuleStatus(installDir, moduleResult) {
  const status = loadInstalledStatus(installDir);
  status.modules = status.modules || {};
  status.modules[moduleResult.module] = moduleResult;
  status.updated_at = new Date().toISOString();
  saveInstalledStatus(installDir, status);
}

function deleteModuleStatus(installDir, moduleName) {
  const status = loadInstalledStatus(installDir);
  if (status.modules && Object.prototype.hasOwnProperty.call(status.modules, moduleName)) {
    delete status.modules[moduleName];
    status.updated_at = new Date().toISOString();
    saveInstalledStatus(installDir, status);
  }
}

function loadSettings(installDir) {
  const p = path.join(installDir, "settings.json");
  if (!fs.existsSync(p)) return {};
  return readJsonFile(p);
}

function saveSettings(installDir, settings) {
  const p = path.join(installDir, "settings.json");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function normalizeHookCommand(cmd) {
  return cmd
    .replace(/['"]/g, "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^(python3|python|py -3)\s+/, "");
}

function hookEntryKey(entry) {
  return JSON.stringify({
    matcher: entry.matcher || "",
    commands: (entry.hooks || []).map((h) => normalizeHookCommand(h.command || "")),
  });
}

function entryPointsInto(entry, roots) {
  const normalize = (s) => s.replace(/\\/g, "/").replace(/['"]/g, "").toLowerCase();
  const normalizedRoots = roots.filter(Boolean).map((root) => normalize(root).replace(/\/+$/, "") + "/");
  return (entry.hooks || []).some((h) => {
    const command = normalize(h.command || "");
    return normalizedRoots.some((root) => command.includes(root));
  });
}

let pythonCommand;
let pythonCommandResolved = false;
let pythonWarningWritten = false;
let skipWrapper = false;

function findPythonCommand() {
  if (process.env.MYCLAUDE_PYTHON) return process.env.MYCLAUDE_PYTHON;
  if (pythonCommandResolved) return pythonCommand;
  const candidates = process.platform === "win32" ? [["python3"], ["python"], ["py", "-3"]] : [["python3"]];
  for (const [cmd, ...rest] of candidates) {
    const result = spawnSync(cmd, [...rest, "-c", "import sys"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10000,
    });
    if (result.status === 0) {
      pythonCommand = [cmd, ...rest].join(" ");
      pythonCommandResolved = true;
      return pythonCommand;
    }
  }
  pythonCommandResolved = true;
  pythonCommand = null;
  return null;
}

function resolvePythonCommand() {
  const found = findPythonCommand();
  if (found) return found;
  if (!pythonWarningWritten) {
    process.stderr.write("Warning: no working Python interpreter found; using python3.\n");
    pythonWarningWritten = true;
  }
  return "python3";
}

function pythonHookNames(modules, repoRoot) {
  const names = [];
  for (const [name, mod] of Object.entries(modules || {})) {
    const ops = Array.isArray(mod && mod.operations) ? mod.operations : [];
    let found = false;
    for (const op of ops) {
      if (!op || op.type !== "copy_dir") continue;
      const source = typeof op.source === "string" ? op.source : op.target;
      if (typeof source !== "string") continue;
      for (const file of [path.join(repoRoot, source, "hooks", "hooks.json"), path.join(repoRoot, source, "hooks.json")]) {
        try {
          const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
          if (JSON.stringify(hooks).match(/\"command\"\s*:\s*\"python3(?=\s)/)) found = true;
        } catch {}
      }
    }
    if (found) names.push(name);
  }
  return names;
}

function requirePythonForHooks(names) {
  if (!names.length || findPythonCommand()) return;
  const tried = process.platform === "win32" ? "python3, python, py -3" : "python3";
  const windowsHint = process.platform === "win32"
    ? ' On Windows, "python"/"python3" may be Microsoft Store stubs; disable them in Settings > Apps > Advanced app settings > App execution aliases.'
    : "";
  throw new Error(`Python 3 is required by hooks of: ${names.join(", ")}. No working Python interpreter found (tried: ${tried}).${windowsHint} Install Python 3 (https://www.python.org/downloads/ with "Add python.exe to PATH", or: winget install Python.Python.3.12), open a new terminal and rerun. Set MYCLAUDE_PYTHON to use a specific interpreter.`);
}

function replaceHookVariables(obj, pluginRoot) {
  if (typeof obj === "string") return obj.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
  if (Array.isArray(obj)) return obj.map((v) => replaceHookVariables(v, pluginRoot));
  if (isPlainObject(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = replaceHookVariables(v, pluginRoot);
    return out;
  }
  return obj;
}

function mergeHooksToSettings(moduleName, hooksConfig, installDir, pluginRoot) {
  if (!hooksConfig || !isPlainObject(hooksConfig)) return false;
  const rawHooks = hooksConfig.hooks;
  if (!rawHooks || !isPlainObject(rawHooks)) return false;

  const moduleHooks = pluginRoot ? replaceHookVariables(rawHooks, pluginRoot) : rawHooks;
  return mergeHookEntries(moduleName, moduleHooks, installDir, pluginRoot ? [pluginRoot] : []);
}

function mergeHookEntries(moduleName, moduleHooks, installDir, pluginRoots) {
  const settings = loadSettings(installDir);
  const before = JSON.stringify(settings.hooks);
  if (!isPlainObject(settings.hooks)) settings.hooks = {};

  for (const [hookType, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    settings.hooks[hookType] = entries.filter((entry) =>
      !(entry && entry.__module__ === moduleName)
    );
  }

  for (const [hookType, hookEntries] of Object.entries(moduleHooks)) {
    if (!Array.isArray(hookEntries)) continue;
    if (!Array.isArray(settings.hooks[hookType])) settings.hooks[hookType] = [];

    for (const entry of hookEntries) {
      if (!isPlainObject(entry)) continue;
      const entryCopy = {
        ...entry,
        hooks: (entry.hooks || []).map((h) => ({
          ...h,
          ...(typeof h.command === "string" && /^python3(?=\s)/.test(h.command)
            ? { command: h.command.replace(/^python3(?=\s)/, () => resolvePythonCommand()) }
            : {}),
        })),
        __module__: moduleName,
      };
      const { __module__, ...plain } = entryCopy;
      if (settings.hooks[hookType].some((old) => old &&
          !Object.prototype.hasOwnProperty.call(old, "__module__") && deepEqual(old, plain))) continue;
      const key = hookEntryKey(entryCopy);
      if (!settings.hooks[hookType].some((existing) => existing && hookEntryKey(existing) === key)) {
        settings.hooks[hookType].push(entryCopy);
      }
    }
  }

  for (const [hookType, entries] of Object.entries(settings.hooks)) {
    if (Array.isArray(entries) && !entries.length) delete settings.hooks[hookType];
  }

  const modified = before !== JSON.stringify(settings.hooks);
  if (modified) saveSettings(installDir, settings);
  return modified;
}

function unmergeHooksFromSettings(moduleName, installDir, pluginRoots = []) {
  const settings = loadSettings(installDir);
  if (!settings.hooks || !isPlainObject(settings.hooks)) return false;

  const before = JSON.stringify(settings.hooks);
  for (const hookType of Object.keys(settings.hooks)) {
    const entries = settings.hooks[hookType];
    if (!Array.isArray(entries)) continue;
    settings.hooks[hookType] = entries.filter((entry) =>
      !(entry && entry.__module__ === moduleName)
    );
    if (!settings.hooks[hookType].length) {
      delete settings.hooks[hookType];
    }
  }

  const modified = before !== JSON.stringify(settings.hooks);
  if (modified) saveSettings(installDir, settings);
  return modified;
}

function mergeModuleHooks(moduleName, mod, installDir) {
  const ops = Array.isArray(mod && mod.operations) ? mod.operations : [];
  const moduleHooks = {};
  const pluginRoots = [];

  for (const op of ops) {
    if (!op || op.type !== "copy_dir") continue;
    const target = typeof op.target === "string" ? op.target : "";
    if (!target) continue;

    const targetDir = path.join(installDir, target);
    for (const hooksFile of [path.join(targetDir, "hooks", "hooks.json"), path.join(targetDir, "hooks.json")]) {
      if (!fs.existsSync(hooksFile)) continue;

      let hooksConfig;
      try {
        hooksConfig = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      } catch {
        continue;
      }
      if (!isPlainObject(hooksConfig.hooks)) continue;
      const pluginRoot = targetDir.replace(/\\/g, "/");
      pluginRoots.push(pluginRoot);
      const hooks = replaceHookVariables(hooksConfig.hooks, pluginRoot);
      for (const [hookType, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries)) continue;
        if (!moduleHooks[hookType]) moduleHooks[hookType] = [];
        moduleHooks[hookType].push(...entries);
      }
    }
  }
  if (!pluginRoots.length) return false;
  return mergeHookEntries(moduleName, moduleHooks, installDir, pluginRoots);
}

async function dirExists(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function mergeDirLooksInstalled(srcDir, installDir) {
  if (!(await dirExists(srcDir))) return false;
  const subdirs = await fs.promises.readdir(srcDir, { withFileTypes: true });
  for (const d of subdirs) {
    if (!d.isDirectory() || d.name === ".claude-plugin") continue;
    const srcSub = path.join(srcDir, d.name);
    const entries = await fs.promises.readdir(srcSub, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const dst = path.join(installDir, d.name, e.name);
      if (fs.existsSync(dst)) return true;
    }
  }
  return false;
}

async function detectInstalledModuleNames(config, repoRoot, installDir) {
  const mods = (config && config.modules) || {};
  const installed = [];

  for (const [name, mod] of Object.entries(mods)) {
    const ops = Array.isArray(mod && mod.operations) ? mod.operations : [];
    let ok = false;

    for (const op of ops) {
      const type = op && op.type;
      if (type === "copy_file" || type === "copy_dir") {
        const target = typeof op.target === "string" ? op.target : "";
        const sharedTarget = ["hooks", "commands", "agents", "skills"].includes(path.normalize(target).replace(/[\\/]+$/, ""));
        if (target && !sharedTarget && fs.existsSync(path.join(installDir, target))) {
          ok = true;
          break;
        }
      } else if (type === "merge_dir") {
        const source = typeof op.source === "string" ? op.source : "";
        if (source && (await mergeDirLooksInstalled(path.join(repoRoot, source), installDir))) {
          ok = true;
          break;
        }
      }
    }

    if (ok) installed.push(name);
  }

  return installed.sort();
}

async function updateInstalledModules(installDir, tag, config, dryRun, explicitForce = false, offline = false, requestedModules = null) {
  validateInstallJson(installDir);
  const mods = (config && config.modules) || {};

  let repoRoot = repoRootFromHere();
  let tmp = null;

  if (tag) {
    tmp = path.join(
      os.tmpdir(),
      `myclaude-update-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    await fs.promises.mkdir(tmp, { recursive: true });
  }

  try {
    if (tag) {
      const archive = path.join(tmp, "src.tgz");
      const url = `https://codeload.github.com/${REPO.owner}/${REPO.name}/tar.gz/refs/tags/${encodeURIComponent(
        tag
      )}`;
      process.stdout.write(`Downloading ${REPO.owner}/${REPO.name}@${tag}...\n`);
      await downloadToFile(url, archive);
      process.stdout.write("Extracting...\n");
      const extracted = path.join(tmp, "src");
      await extractTarGz(archive, extracted);
      repoRoot = extracted;
    } else {
      process.stdout.write("Offline mode: updating from local package contents.\n");
    }

    const fromStatus = readInstalledModuleNamesFromStatus(installDir);
    if (fromStatus === null) {
      const detected = await detectInstalledModuleNames(config, repoRoot, installDir);
      process.stdout.write(`No installation status found. Detected: ${detected.join(", ") || "none"}.${detected.length ? ` Run: npx github:miraserver/myclaude --module ${detected.join(",")} --update` : ""}\n`);
      if (requestedModules && requestedModules !== "all") {
        for (const name of requestedModules.split(",").map(s => s.trim()).filter(Boolean)) {
          process.stdout.write(`${name} is not installed; run without --update to install it\n`);
        }
      }
      return;
    }
    const status = loadInstalledStatus(installDir).modules;
    const candidates = requestedModules && requestedModules !== "all"
      ? requestedModules.split(",").map(s => s.trim()).filter(Boolean) : fromStatus;
    const toUpdate = candidates.filter((name) => {
      const entry = status[name];
      if (!Object.prototype.hasOwnProperty.call(status, name) ||
          !isPlainObject(entry) || (Object.prototype.hasOwnProperty.call(entry, "status") &&
          !["installed", "success"].includes(entry.status))) {
        process.stdout.write(`${name} is not installed; run without --update to install it\n`);
        return false;
      }
      return Object.prototype.hasOwnProperty.call(mods, name) || name.startsWith("skill:");
    });

    if (!toUpdate.length) {
      process.stdout.write(`No installed modules found in ${installDir}.\n`);
      return;
    }

    if (dryRun) {
      for (const name of toUpdate) process.stdout.write(`module:${name}\n`);
      return;
    }

    const selectedModules = {};
    for (const name of toUpdate) {
      if (name.startsWith("skill:")) {
        const skillName = name.slice(6);
        selectedModules[name] = { operations: [{ type: "copy_dir", source: `skills/${skillName}`, target: `skills/${skillName}` }] };
      } else if (mods[name]) selectedModules[name] = mods[name];
    }
    requirePythonForHooks(pythonHookNames(selectedModules, repoRoot));
    await migratePluginManifestOwnership(installDir, repoRoot, config);

    await fs.promises.mkdir(installDir, { recursive: true });
    const installState = { wrapperInstalled: false, continueWrapperFailure: true, failures: [] };

    async function ensureWrapperInstalled() {
      if (installState.wrapperInstalled) return;
      process.stdout.write("Installing codeagent-wrapper...\n");
      try {
        await runInstallSh(repoRoot, installDir, tag, offline);
      } catch (err) {
        installState.failures.push(`codeagent-wrapper: ${err.message}`);
      }
      installState.wrapperInstalled = true;
    }

    for (const name of toUpdate) {
      if (WRAPPER_REQUIRED_MODULES.has(name)) await ensureWrapperInstalled();
      process.stdout.write(`Updating module: ${name}\n`);
      try {
        let r;
        if (name.startsWith("skill:")) {
          const skillName = name.slice(6);
          if (WRAPPER_REQUIRED_SKILLS.has(skillName)) await ensureWrapperInstalled();
          r = await applyModule(name, { modules: { [name]: { operations: [{ type: "copy_dir", source: `skills/${skillName}`, target: `skills/${skillName}` }] } } }, repoRoot, installDir, true, tag, installState, explicitForce, offline);
          r.status = "installed";
        } else r = await applyModule(name, config, repoRoot, installDir, true, tag, installState, explicitForce, offline);
        r.version = tag || "offline";
        upsertModuleStatus(installDir, r);
      } catch (err) {
        installState.failures.push(`${name}: ${err.message}`);
      }
    }
    if (installState.failures.length) throw new Error(`Update failures:\n${installState.failures.join("\n")}`);
  } finally {
    if (tmp) await rmTree(tmp);
  }
}

function buildItems(config, skills) {
  const items = [{ id: "codeagent-wrapper", label: "codeagent-wrapper", kind: "wrapper" }];

  const modules = (config && config.modules) || {};
  for (const [name, mod] of Object.entries(modules)) {
    const desc = mod && typeof mod.description === "string" ? mod.description : "";
      items.push({
      id: `module:${name}`,
      label: `module:${name}${desc ? ` - ${desc}` : ""}`,
      kind: "module",
        moduleName: name,
    });
  }

  for (const s of skills) {
    items.push({ id: `skill:${s}`, label: `skill:${s}`, kind: "skill", skillName: s });
  }

  return items;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function renderMenuFrame(items, idx, selected, offset, title, columns, rows) {
  const width = Math.max(10, (columns || 80) - 1);
  const visibleRows = Math.max(1, (rows || 24) - 4);
  offset = Math.max(0, Math.min(offset, items.length - visibleRows));
  if (idx < offset) offset = idx;
  else if (idx >= offset + visibleRows) offset = idx - visibleRows + 1;

  const position = items.length > visibleRows ? `(${idx + 1}/${items.length}) ` : "";
  const lines = [title, `${position}↑↓ move  Space toggle  Enter confirm  q quit`, ""];
  for (let i = offset; i < Math.min(items.length, offset + visibleRows); i++) {
    const cursor = i === idx ? ">" : " ";
    const box = selected.has(items[i].id) ? "[x]" : "[ ]";
    lines.push(`${cursor} ${box} ${items[i].label}`);
  }
  const frame = lines.map((line) => {
    const text = line.length > width ? line.slice(0, width - 1) + "…" : line;
    return text + "\x1b[K";
  }).join("\n");
  return { frame: "\x1b[H" + frame + "\x1b[J", offset };
}

async function promptMultiSelect(items, title) {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY. Use --list or run in an interactive terminal.");
  }

  let idx = 0;
  let offset = 0;
  let closed = false;
  const selected = new Set();

  function render() {
    const result = renderMenuFrame(items, idx, selected, offset, title,
      process.stdout.columns, process.stdout.rows);
    offset = result.offset;
    process.stdout.write(result.frame);
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    process.stdin.removeListener("keypress", onKey);
    process.stdout.removeListener("resize", onResize);
    try {
      process.stdin.setRawMode(false);
    } finally {
      try {
        process.stdin.pause();
      } finally {
        process.stdout.write("\x1b[?25h\x1b[?1049l");
      }
    }
  }

  function fail(err) {
    try {
      cleanup();
    } finally {
      rejectPick(err);
    }
  }

  function onResize() {
    if (closed) return;
    try {
      render();
    } catch (err) {
      fail(err);
    }
  }

  function onKey(_, key) {
    if (closed || !key) return;
    try {
      if (key.name === "c" && key.ctrl) {
        cleanup();
        return process.exit(130);
      }
      if (key.name === "q") {
        cleanup();
        return process.exit(0);
      }
      if (key.name === "up") idx = (idx - 1 + items.length) % items.length;
      else if (key.name === "down") idx = (idx + 1) % items.length;
      else if (key.name === "space") {
        const id = items[idx].id;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      } else if (key.name === "return") {
        cleanup();
        const picked = items.filter((it) => selected.has(it.id));
        return resolvePick(picked);
      }
      render();
    } catch (err) {
      fail(err);
    }
  }

  let resolvePick;
  let rejectPick;
  const result = new Promise((resolve, reject) => {
    resolvePick = resolve;
    rejectPick = reject;
  });

  try {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKey);
    process.stdout.on("resize", onResize);
    render();
  } catch (err) {
    fail(err);
  }
  return result;
}

function isZeroBlock(b) {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

function tarString(b, start, len) {
  return b
    .toString("utf8", start, start + len)
    .replace(/\0.*$/, "")
    .trim();
}

function tarOctal(b, start, len) {
  const s = tarString(b, start, len);
  if (!s) return 0;
  return parseInt(s, 8) || 0;
}

function safePosixPath(p) {
  const norm = path.posix.normalize(p);
  if (norm.startsWith("/") || norm.startsWith("..") || norm.includes("/../")) {
    throw new Error(`Unsafe path in archive: ${p}`);
  }
  return norm;
}

async function extractTarGz(archivePath, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(archivePath).pipe(gunzip);

  let buf = Buffer.alloc(0);
  let file = null;
  let pad = 0;
  let zeroBlocks = 0;

  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (pad) {
        if (buf.length < pad) break;
        buf = buf.slice(pad);
        pad = 0;
      }

      if (!file) {
        if (buf.length < 512) break;
        const header = buf.slice(0, 512);
        buf = buf.slice(512);

        if (isZeroBlock(header)) {
          zeroBlocks++;
          if (zeroBlocks >= 2) return;
          continue;
        }
        zeroBlocks = 0;

        const name = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 155);
        const full = prefix ? `${prefix}/${name}` : name;
        const size = tarOctal(header, 124, 12);
        const mode = tarOctal(header, 100, 8);
        const typeflag = header[156];

        const rel = safePosixPath(full.split("/").slice(1).join("/"));
        if (!rel || rel === ".") {
          file = null;
          pad = 0;
          continue;
        }

        const outPath = path.join(destDir, ...rel.split("/"));
        if (typeflag === 53) {
          await fs.promises.mkdir(outPath, { recursive: true });
          if (mode) await fs.promises.chmod(outPath, mode);
          file = null;
          pad = 0;
          continue;
        }

        file = { outPath, size, remaining: size, chunks: [], mode };
        if (size === 0) {
          await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
          await fs.promises.writeFile(outPath, Buffer.alloc(0));
          if (mode) await fs.promises.chmod(outPath, mode);
          file = null;
          pad = 0;
        }
        continue;
      }

      if (buf.length < file.remaining) {
        file.chunks.push(buf);
        file.remaining -= buf.length;
        buf = Buffer.alloc(0);
        break;
      }

      file.chunks.push(buf.slice(0, file.remaining));
      buf = buf.slice(file.remaining);
      file.remaining = 0;

      await fs.promises.mkdir(path.dirname(file.outPath), { recursive: true });
      await fs.promises.writeFile(file.outPath, Buffer.concat(file.chunks));
      if (file.mode) await fs.promises.chmod(file.outPath, file.mode);

      pad = (512 - (file.size % 512)) % 512;
      file = null;
    }
  }
}

function fileHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function relativeFilePath(installDir, target) {
  return path.relative(installDir, target).split(path.sep).join("/");
}

function canonicalFileKey(rel) {
  return typeof rel === "string" && !/[\\:]/.test(rel) &&
    rel.split("/").every((part) => part && part !== "." && part !== "..");
}

function ownershipFiles(entry) {
  const files = {};
  if (!entry || !isPlainObject(entry.files)) return files;
  for (const [rel, hash] of Object.entries(entry.files)) {
    if (canonicalFileKey(rel)) files[rel] = hash;
    else process.stderr.write(`Warning: ignoring non-canonical ownership key: ${rel}\n`);
  }
  return files;
}

function retainedFiles(entry, installDir) {
  return Object.fromEntries(Object.entries(ownershipFiles(entry))
    .filter(([rel]) => fs.existsSync(path.join(installDir, rel))));
}

async function copyFile(src, dst, force, files, installDir, previous = {}, explicitForce = force) {
  const rel = installDir && relativeFilePath(installDir, dst);
  if (!explicitForce && Object.prototype.hasOwnProperty.call(previous, rel) && fs.existsSync(dst) &&
      fileHash(await fs.promises.readFile(dst)) !== previous[rel] && !(await filesIdentical(src, dst))) {
    process.stdout.write(`Keeping ${dst}: modified locally (use --force to overwrite)\n`);
    return false;
  }
  if (!force && fs.existsSync(dst)) {
    if (files && await filesIdentical(src, dst)) files[rel] = fileHash(await fs.promises.readFile(src));
    return false;
  }
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.copyFile(src, dst);
  const st = await fs.promises.stat(src);
  await fs.promises.chmod(dst, st.mode);
  if (files) files[relativeFilePath(installDir, dst)] = fileHash(await fs.promises.readFile(dst));
  return true;
}

async function copyDirRecursive(src, dst, force, files, installDir, previous, explicitForce) {
  await fs.promises.mkdir(dst, { recursive: true });

  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDirRecursive(s, d, force, files, installDir, previous, explicitForce);
    else if (e.isFile()) await copyFile(s, d, force, files, installDir, previous, explicitForce);
  }
}

async function filesIdentical(src, dst) {
  try {
    const [srcBuf, dstBuf] = await Promise.all([
      fs.promises.readFile(src),
      fs.promises.readFile(dst),
    ]);
    return srcBuf.equals(dstBuf);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") return false;
    throw err;
  }
}

async function mergeDir(src, installDir, force, moduleName, previouslyOwned, explicitForce, files, previous, skipped) {
  const installed = [];
  const subdirs = await fs.promises.readdir(src, { withFileTypes: true });
  for (const d of subdirs) {
    if (!d.isDirectory() || d.name === ".claude-plugin") continue;
    const srcSub = path.join(src, d.name);
    const dstSub = path.join(installDir, d.name);
    await fs.promises.mkdir(dstSub, { recursive: true });
    const entries = await fs.promises.readdir(srcSub, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = `${d.name}/${e.name}`;
      const source = path.join(srcSub, e.name);
      const target = path.join(dstSub, e.name);
      const exists = fs.existsSync(target);
      const identical = exists && await filesIdentical(source, target);
      if (exists && !previouslyOwned.has(rel) && !Object.prototype.hasOwnProperty.call(previous, rel) && !identical && !explicitForce) {
        skipped.count++;
        process.stdout.write(`skipped ${target}: exists and is not owned by ${moduleName} (use --force to overwrite)\n`);
        continue;
      }
      const didCopy = await copyFile(source, target, force, files, installDir, previous, explicitForce);
      if (didCopy || identical) {
        installed.push(rel);
        if (identical) files[rel] = fileHash(await fs.promises.readFile(target));
      }
    }
  }
  return installed;
}

async function migratePluginManifestOwnership(installDir, repoRoot, config) {
  const rel = ".claude-plugin/plugin.json";
  const status = loadInstalledStatus(installDir);
  const hashes = new Set();
  let recorded = false;
  for (const entry of Object.values(status.modules)) {
    if (entry.files && Object.prototype.hasOwnProperty.call(entry.files, rel)) {
      recorded = true;
      hashes.add(entry.files[rel]);
      delete entry.files[rel];
    }
    if (Array.isArray(entry.merge_dir_files) && entry.merge_dir_files.includes(rel)) {
      recorded = true;
      entry.merge_dir_files = entry.merge_dir_files.filter((file) => file !== rel);
    }
  }
  if (!recorded) return;
  const target = path.join(installDir, rel);
  if (fs.existsSync(target)) {
    const bytes = await fs.promises.readFile(target);
    let matches = hashes.has(fileHash(bytes));
    if (!matches) {
      for (const mod of Object.values((config && config.modules) || {})) {
        for (const op of (mod && Array.isArray(mod.operations) ? mod.operations : [])) {
          if (op.type !== "merge_dir" || typeof op.source !== "string") continue;
          const source = path.join(repoRoot, op.source, rel);
          if (fs.existsSync(source) && bytes.equals(await fs.promises.readFile(source))) matches = true;
        }
      }
    }
    if (matches) await fs.promises.unlink(target);
    else process.stdout.write(`Keeping ${target}: modified locally\n`);
  }
  if (fs.existsSync(path.dirname(target))) await tryRemoveEmptyDir(path.dirname(target));
  status.updated_at = new Date().toISOString();
  saveInstalledStatus(installDir, status);
}

function installScriptCommand(repoRoot, platform = process.platform) {
  return platform === "win32"
    ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", `""${path.join(repoRoot, "install.bat")}""`], windowsVerbatimArguments: true }
    : { cmd: "bash", args: [path.join(repoRoot, "install.sh")] };
}

function runInstallSh(repoRoot, installDir, tag, offline = false) {
  if (offline) {
    process.stdout.write("Offline mode: skipping codeagent-wrapper download.\n");
    return Promise.resolve();
  }
  if (skipWrapper || process.env.MYCLAUDE_SKIP_WRAPPER === "1") {
    process.stdout.write("Skipping codeagent-wrapper install.\n");
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const { cmd, args } = installScriptCommand(repoRoot);
    const env = { ...process.env, INSTALL_DIR: installDir, SKIP_WARNING: "1" };
    if (tag) env.CODEAGENT_WRAPPER_VERSION = tag;
    const p = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      ...(cmd === "cmd.exe" ? { windowsVerbatimArguments: true } : {}),
    });
    p.on("error", (err) => reject(new Error(`Unable to start install script (${cmd}): ${err.message}`)));
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`install script failed (exit ${code})`));
    });
  });
}

async function rmTree(p) {
  if (!fs.existsSync(p)) return;
  if (fs.promises.rm) {
    await fs.promises.rm(p, { recursive: true, force: true });
    return;
  }
  await fs.promises.rmdir(p, { recursive: true });
}

function defaultModelsConfig() {
  return {
    default_backend: "codex",
    default_model: "gpt-6.1-sol",
    backends: {},
    agents: {},
  };
}

function agentDefaultsHash(cfg) {
  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  const { __module__, __hash__, ...defaults } = cfg;
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(defaults))).digest("hex").slice(0, 12);
}

function writeModels(modelsPath, models) {
  fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(modelsPath, 0o600);
}

function unmergeModuleAgents(moduleName, config, installDir) {
  const modelsPath = path.join(os.homedir(), ".codeagent", "models.json");
  if (!fs.existsSync(modelsPath)) return;
  let models;
  try { models = readJsonFile(modelsPath); }
  catch (err) { process.stderr.write(`Warning: leaving ${modelsPath} untouched: ${err.message}\n`); return; }
  if (!isPlainObject(models) || !isPlainObject(models.agents)) return;
  let modified = false;
  const installed = loadInstalledStatus(installDir).modules;
  for (const [name, agent] of Object.entries(models.agents)) {
    if (!agent || agent.__module__ !== moduleName) continue;
    if (agent.__hash__ && agentDefaultsHash(agent) !== agent.__hash__) {
      process.stdout.write(`Keeping user-edited agent: ${name}\n`);
      continue;
    }
    delete models.agents[name];
    modified = true;
    for (const [other, status] of Object.entries(installed)) {
      const replacement = config.modules[other] && config.modules[other].agents && config.modules[other].agents[name];
      if (other !== moduleName && status.status === "success" && replacement) {
        const defaults = relocatedAgentDefaults(replacement, installDir);
        models.agents[name] = { ...defaults, __module__: other, __hash__: agentDefaultsHash(defaults) };
        break;
      }
    }
  }
  if (modified) writeModels(modelsPath, models);
}

function relocatedAgentDefaults(agentCfg, installDir) {
  const defaults = { ...agentCfg };
  if (path.resolve(installDir) !== path.resolve(os.homedir(), ".claude") &&
      typeof defaults.prompt_file === "string" && defaults.prompt_file.startsWith("~/.claude/")) {
    defaults.prompt_file = path.join(installDir, defaults.prompt_file.slice("~/.claude/".length)).replace(/\\/g, "/");
  }
  return defaults;
}

function mergeModuleAgentsToModels(moduleName, mod, repoRoot, installDir = path.join(os.homedir(), ".claude")) {
  const moduleAgents = mod && mod.agents;
  if (!isPlainObject(moduleAgents) || !Object.keys(moduleAgents).length) return false;

  const modelsPath = path.join(os.homedir(), ".codeagent", "models.json");
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true, mode: 0o700 });

  let models;
  if (fs.existsSync(modelsPath)) {
    models = readJsonFile(modelsPath);
  } else {
    const templatePath = path.join(repoRoot, "templates", "models.json.example");
    if (fs.existsSync(templatePath)) {
      models = readJsonFile(templatePath);
      if (!isPlainObject(models)) models = defaultModelsConfig();
      models.agents = {};
    } else {
      models = defaultModelsConfig();
    }
  }

  if (!isPlainObject(models)) models = defaultModelsConfig();
  if (!isPlainObject(models.agents)) models.agents = {};

  let modified = false;
  for (const [agentName, agentCfg] of Object.entries(moduleAgents)) {
    if (!isPlainObject(agentCfg)) continue;
    const existing = models.agents[agentName];
    const canOverwrite = !isPlainObject(existing) || Object.prototype.hasOwnProperty.call(existing, "__module__");
    if (!canOverwrite) continue;
    if (isPlainObject(existing) && Object.prototype.hasOwnProperty.call(existing, "__hash__") &&
        agentDefaultsHash(existing) !== existing.__hash__) continue;
    const defaults = relocatedAgentDefaults(agentCfg, installDir);
    const next = { ...defaults, __module__: moduleName, __hash__: agentDefaultsHash(defaults) };
    if (!deepEqual(existing, next)) {
      models.agents[agentName] = next;
      modified = true;
    }
  }

  if (modified) writeModels(modelsPath, models);
  return modified;
}

async function applyModule(moduleName, config, repoRoot, installDir, force, tag, installState, explicitForce = force, offline = false) {
  validateInstallJson(installDir);
  const mod = config && config.modules && config.modules[moduleName];
  if (!mod) throw new Error(`Unknown module: ${moduleName}`);
  const ops = Array.isArray(mod.operations) ? mod.operations : [];
  const result = {
    module: moduleName,
    status: "success",
    operations: [],
    files: {},
    installed_at: new Date().toISOString(),
  };
  const status = loadInstalledStatus(installDir);
  const previous = status.modules[moduleName];
  const previousFiles = ownershipFiles(previous);
  result.files = retainedFiles(previous, installDir);
  const skipped = { count: 0 };
  const previouslyOwned = new Set(previous && Array.isArray(previous.merge_dir_files) ? previous.merge_dir_files.filter(canonicalFileKey) : []);
  const mergeDirFiles = new Set([...previouslyOwned].filter((rel) => fs.existsSync(path.join(installDir, rel))));

  for (const op of ops) {
    const type = op && op.type;
    try {
      if (type === "copy_file") {
        await copyFile(path.join(repoRoot, op.source), path.join(installDir, op.target), force, result.files, installDir, previousFiles, explicitForce);
      } else if (type === "copy_dir") {
        await copyDirRecursive(path.join(repoRoot, op.source), path.join(installDir, op.target), force, result.files, installDir, previousFiles, explicitForce);
      } else if (type === "merge_dir") {
        const installed = await mergeDir(path.join(repoRoot, op.source), installDir, force, moduleName, previouslyOwned, explicitForce, result.files, previousFiles, skipped);
        for (const rel of installed) mergeDirFiles.add(rel);
      } else if (type === "run_command") {
        const cmd = typeof op.command === "string" ? op.command.trim() : "";
        if (cmd !== "bash install.sh") {
          throw new Error(`Refusing run_command: ${cmd || "(empty)"}`);
        }
        if (installState && installState.wrapperInstalled) {
          result.operations.push({ type, status: "success", skipped: true });
          continue;
        }
        try {
          await runInstallSh(repoRoot, installDir, tag, offline);
        } catch (err) {
          if (!installState || !installState.continueWrapperFailure) throw err;
          installState.failures.push(`codeagent-wrapper: ${err.message}`);
        }
        if (installState) installState.wrapperInstalled = true;
      } else {
        throw new Error(`Unsupported operation type: ${type}`);
      }
      result.operations.push({ type, status: "success" });
    } catch (err) {
      result.status = "failed";
      result.operations.push({
        type,
        status: "failed",
        error: err && err.message ? err.message : String(err),
      });
      throw err;
    }
  }

  if (skipped.count) process.stdout.write(`Module ${moduleName}: skipped ${skipped.count} foreign merge_dir file(s); use --force to take them over\n`);
  if (previouslyOwned.size || ops.some((op) => op && op.type === "merge_dir")) result.merge_dir_files = [...mergeDirFiles];

  try {
    if (mergeModuleHooks(moduleName, mod, installDir)) {
      result.has_hooks = true;
      result.operations.push({ type: "merge_hooks", status: "success" });
    }
  } catch (err) {
    result.status = "failed";
    result.operations.push({
      type: "merge_hooks",
      status: "failed",
      error: err && err.message ? err.message : String(err),
    });
    upsertModuleStatus(installDir, result);
    throw err;
  }

  try {
    if (mergeModuleAgentsToModels(moduleName, mod, repoRoot, installDir)) {
      result.has_agents = true;
      result.operations.push({ type: "merge_agents", status: "success" });
    }
  } catch (err) {
    result.status = "failed";
    result.operations.push({
      type: "merge_agents",
      status: "failed",
      error: err && err.message ? err.message : String(err),
    });
    upsertModuleStatus(installDir, result);
    throw err;
  }

  return result;
}

async function tryRemoveEmptyDir(p) {
  try {
    const entries = await fs.promises.readdir(p);
    if (!entries.length) await fs.promises.rmdir(p);
  } catch {
    // ignore
  }
}

async function removePathIfExists(p) {
  if (!fs.existsSync(p)) return;
  const st = await fs.promises.lstat(p);
  if (st.isDirectory()) {
    await rmTree(p);
    return;
  }
  try {
    await fs.promises.unlink(p);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}

async function listSourceTree(srcDir, rel = "", files = [], dirs = []) {
  dirs.push(rel);
  for (const entry of await fs.promises.readdir(srcDir, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    const childSrc = path.join(srcDir, entry.name);
    if (entry.isDirectory()) await listSourceTree(childSrc, childRel, files, dirs);
    else files.push(childRel);
  }
  return { files, dirs };
}

async function removeCopyDirContents(srcDir, targetDir, removeFile, cleanupDirs) {
  const { files, dirs } = await listSourceTree(srcDir);
  for (const rel of files) await removeFile(path.join(targetDir, rel), path.join(srcDir, rel), true);
  for (const rel of dirs) cleanupDirs.add(path.join(targetDir, rel));
}

async function uninstallModule(moduleName, config, repoRoot, installDir, dryRun) {
  loadInstalledStatus(installDir);
  loadSettings(installDir);
  const skillName = moduleName.startsWith("skill:") ? moduleName.slice(6) : null;
  const mod = skillName
    ? { operations: [{ type: "copy_dir", source: `skills/${skillName}`, target: `skills/${skillName}` }] }
    : config && config.modules && config.modules[moduleName];
  if (!mod) throw new Error(`Unknown module: ${moduleName}`);
  const ops = Array.isArray(mod.operations) ? mod.operations : [];
  const status = loadInstalledStatus(installDir);
  if (!dryRun) await migratePluginManifestOwnership(installDir, repoRoot, config);
  const migratedStatus = loadInstalledStatus(installDir);
  const moduleStatus = (migratedStatus.modules && migratedStatus.modules[moduleName]) || {};
  const recordedMerge = Array.isArray(moduleStatus.merge_dir_files) ? moduleStatus.merge_dir_files : null;
  const hasFiles = isPlainObject(moduleStatus.files);
  const recordedFiles = ownershipFiles(moduleStatus);
  const keptMerge = new Set();
  function sharedFiles(rel) {
    return Object.entries(migratedStatus.modules).filter(([name, entry]) => {
      if (name === moduleName || !["installed", "success", "partial_uninstall"].includes(entry.status)) return false;
      if (Object.prototype.hasOwnProperty.call(ownershipFiles(entry), rel) ||
          (Array.isArray(entry.merge_dir_files) && entry.merge_dir_files.filter(canonicalFileKey).includes(rel))) return true;
      const otherSkill = name.startsWith("skill:") ? name.slice(6) : null;
      const operations = otherSkill ? [{ type: "copy_dir", target: `skills/${otherSkill}` }] :
        ((((config && config.modules) || {})[name] || {}).operations || []);
      return [...operations, ...(entry.operations || [])].some((op) => {
        const target = typeof op.target === "string" ? op.target.replace(/\\/g, "/").replace(/\/+$/, "") : "";
        return target && (op.type === "copy_file" ? rel === target :
          op.type === "copy_dir" && rel.startsWith(target + "/"));
      });
    });
  }
  const keptFiles = {};
  const processed = new Set();
  const cleanupDirs = new Set();
  async function removeFile(target, source, requireSource = false) {
    const rel = relativeFilePath(installDir, target);
    if (!canonicalFileKey(rel)) {
      process.stderr.write(`Warning: ignoring non-canonical ownership key: ${rel}\n`);
      return;
    }
    if (processed.has(rel)) return;
    processed.add(rel);
    if (!fs.existsSync(target)) return;
    const recorded = Object.prototype.hasOwnProperty.call(recordedFiles, rel);
    if (hasFiles && !recorded && !(recordedMerge && recordedMerge.includes(rel))) return;
    let expected = recorded ? recordedFiles[rel] : undefined;
    const keep = () => {
      if (expected !== undefined) keptFiles[rel] = expected;
      if (recordedMerge && recordedMerge.includes(rel)) keptMerge.add(rel);
    };
    let parentRel;
    try {
      parentRel = path.relative(fs.realpathSync(installDir), fs.realpathSync(path.dirname(target)));
    } catch (err) {
      process.stderr.write(`Warning: keeping ${target}: cannot verify parent directory: ${err.message}\n`);
      keep();
      return;
    }
    if (parentRel === ".." || parentRel.startsWith(".." + path.sep) || path.isAbsolute(parentRel)) {
      process.stderr.write(`Warning: keeping ${target}: parent escapes install directory\n`);
      keep();
      return;
    }
    if (!recorded && source) {
      try { expected = fileHash(await fs.promises.readFile(source)); } catch {
        // Directory copies historically preserve files when comparison is unavailable.
        // Single-file copies retain their legacy source-unavailable removal behavior.
        if (requireSource) return;
      }
    }
    const shared = sharedFiles(rel);
    if (shared.length) {
      if (!dryRun && expected !== undefined) {
        for (const [name, entry] of shared) {
          if (Object.prototype.hasOwnProperty.call(ownershipFiles(entry), rel)) continue;
          entry.files = { ...ownershipFiles(entry), [rel]: expected };
          upsertModuleStatus(installDir, { ...entry, module: name });
        }
      }
      process.stdout.write(`Keeping ${target}: shared with another installed module\n`);
      return;
    }
    if (expected !== undefined && (!fs.lstatSync(target).isFile() ||
        fileHash(await fs.promises.readFile(target)) !== expected)) {
      process.stdout.write(`Keeping ${target}: differs from the installed copy\n`);
      keep();
      return;
    }
    if (dryRun) process.stdout.write(`- remove ${target}\n`);
    else await removePathIfExists(target);
  }

  // Recorded ownership survives source files and entire operations being removed upstream.
  for (const rel of Object.keys(recordedFiles)) {
    const target = path.resolve(installDir, rel);
    const relative = path.relative(path.resolve(installDir), target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await removeFile(target);
    for (let dir = path.dirname(target); dir !== path.resolve(installDir); dir = path.dirname(dir)) {
      cleanupDirs.add(dir);
    }
  }

  for (const op of ops) {
    const type = op && op.type;
    if (type === "copy_file") {
      const target = typeof op.target === "string" ? op.target : "";
      if (!target) continue;
      await removeFile(path.join(installDir, target),
        typeof op.source === "string" && op.source ? path.join(repoRoot, op.source) : null);
      continue;
    }

    if (type === "copy_dir") {
      const target = typeof op.target === "string" ? op.target : "";
      if (!target) continue;
      const srcDir = typeof op.source === "string" ? path.join(repoRoot, op.source) : "";
      const targetDir = path.join(installDir, target);
      if (srcDir && await dirExists(srcDir)) {
        await removeCopyDirContents(srcDir, targetDir, removeFile, cleanupDirs);
      } else {
        process.stdout.write(`Keeping ${targetDir}: source unavailable\n`);
      }
      continue;
    }

    if (type !== "merge_dir") continue;
    const source = typeof op.source === "string" ? op.source : "";
    if (!source) continue;

    if (recordedMerge) {
      for (const rel of recordedMerge) {
        if (!canonicalFileKey(rel)) {
          process.stderr.write(`Warning: ignoring non-canonical ownership key: ${rel}\n`);
          continue;
        }
        await removeFile(path.join(installDir, rel), path.join(repoRoot, source, rel), true);
        cleanupDirs.add(path.dirname(path.join(installDir, rel)));
      }
      continue;
    }
    const srcDir = path.join(repoRoot, source);
    if (!(await dirExists(srcDir))) continue;
    const subdirs = await fs.promises.readdir(srcDir, { withFileTypes: true });
    for (const d of subdirs) {
      if (!d.isDirectory()) continue;
      const srcSub = path.join(srcDir, d.name);
      for (const e of await fs.promises.readdir(srcSub, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        await removeFile(path.join(installDir, d.name, e.name), path.join(srcSub, e.name), true);
        cleanupDirs.add(path.join(installDir, d.name));
      }
    }
  }

  const remaining = [...new Set([...Object.keys(keptFiles), ...keptMerge])];
  if (remaining.length) process.stdout.write(`Module ${moduleName} partially uninstalled; remaining files: ${remaining.join(", ")}\n`);
  if (dryRun) return;
  for (const dir of [...cleanupDirs].sort((a, b) => b.length - a.length)) await tryRemoveEmptyDir(dir);
  const pluginRoots = ops
    .filter((op) => op && op.type === "copy_dir" && typeof op.target === "string" && op.target &&
      typeof op.source === "string" && fs.existsSync(path.join(repoRoot, op.source, "hooks", "hooks.json")))
    .map((op) => path.resolve(installDir, op.target).replace(/\\/g, "/"));
  unmergeHooksFromSettings(moduleName, installDir, pluginRoots);
  unmergeModuleAgents(moduleName, config, installDir);
  if (remaining.length) upsertModuleStatus(installDir, { ...moduleStatus, module: moduleName, status: "partial_uninstall", ...((hasFiles || Object.keys(keptFiles).length) ? { files: keptFiles } : {}), ...(recordedMerge ? { merge_dir_files: [...keptMerge] } : {}) });
  else deleteModuleStatus(installDir, moduleName);
}

async function installDefaultConfigs(installDir, repoRoot, withClaudeMd = false, ensureWrapperInstalled = async () => {}) {
  try {
    const claudeMdTarget = path.join(installDir, "CLAUDE.md");
    const claudeMdSrc = path.join(repoRoot, "memorys", "CLAUDE.md");
    if (withClaudeMd && !fs.existsSync(claudeMdTarget) && fs.existsSync(claudeMdSrc)) {
      await fs.promises.copyFile(claudeMdSrc, claudeMdTarget);
      process.stdout.write(`Installed CLAUDE.md to ${claudeMdTarget}\n`);
    }
    if (withClaudeMd) await ensureWrapperInstalled();
    const skillTarget = path.join(installDir, "skills", "codeagent", "SKILL.md");
    if (fs.existsSync(claudeMdTarget) && fs.existsSync(claudeMdSrc) &&
        fs.readFileSync(claudeMdTarget).equals(fs.readFileSync(claudeMdSrc)) &&
        !fs.existsSync(skillTarget)) {
      await fs.promises.mkdir(path.dirname(skillTarget), { recursive: true });
      await fs.promises.copyFile(path.join(repoRoot, "skills", "codeagent", "SKILL.md"),
        skillTarget, fs.constants.COPYFILE_EXCL);
      process.stdout.write("Installed codeagent skill (required by CLAUDE.md)\n");
    }
  } catch (err) {
    process.stderr.write(`Warning: could not install default configs: ${err.message}\n`);
  }
}

function printPostInstallInfo(installDir) {
  process.stdout.write("\n");
  if (typeof fs.existsSync === "function" && !fs.existsSync(path.join(installDir, "CLAUDE.md"))) {
    process.stdout.write("Optional: add --with-claude-md to install the global CLAUDE.md workflow instructions.\n");
  }

  // Check codeagent-wrapper version
  const wrapperBin = wrapperBinPath(installDir);
  let wrapperVersion = null;
  try {
    const r = spawnSync(wrapperBin, ["--version"], { timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      wrapperVersion = r.stdout.toString().trim();
    }
  } catch {}

  // Check PATH
  const binDir = path.dirname(wrapperBinPath(installDir));
  const envPath = process.env.PATH || "";
  const pathsEqual = (left, right) => {
    if (process.platform === "win32") {
      return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    }
    try {
      return fs.realpathSync(left) === fs.realpathSync(right);
    } catch {
      return left === right;
    }
  };
  const pathOk = envPath.split(path.delimiter).some((p) => pathsEqual(p, binDir));

  // Check backend CLIs
  const whichCmd = process.platform === "win32" ? "where" : "which";
  const backends = ["codex", "claude", "gemini", "opencode"];
  const detected = {};
  for (const name of backends) {
    try {
      const r = spawnSync(whichCmd, [name], { timeout: 3000 });
      detected[name] = r.status === 0;
    } catch {
      detected[name] = false;
    }
  }

  process.stdout.write("Setup Complete!\n");
  process.stdout.write(`  codeagent-wrapper: ${wrapperVersion || "(not found)"} ${wrapperVersion ? "✓" : "✗"}\n`);
  process.stdout.write(`  PATH: ${binDir} ${pathOk ? "✓" : "✗ (not in PATH)"}\n`);
  process.stdout.write("\nBackend CLIs detected:\n");
  process.stdout.write("  " + backends.map((b) => `${b} ${detected[b] ? "✓" : "✗"}`).join("  |  ") + "\n");
  process.stdout.write("\nNext steps:\n");
  process.stdout.write("  1. Log in to each backend CLI you use (codex login / claude / gemini), or remap agents in ~/.codeagent/models.json; api_key there is optional.\n");
  process.stdout.write('  2. Try: /do "your first task"\n');
  process.stdout.write("\n");
}

async function installSelected(picks, tag, config, installDir, force, dryRun, offline = false, withClaudeMd = false) {
  validateInstallJson(installDir);
  const needRepo = picks.some((p) => p.kind !== "wrapper");
  const needWrapper = picks.some((p) => p.kind === "wrapper");

  if (dryRun) {
    for (const p of picks) process.stdout.write(`- ${p.id}\n`);
    return;
  }

  const tmp = path.join(
    os.tmpdir(),
    `myclaude-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );
  await fs.promises.mkdir(tmp, { recursive: true });

  try {
    let repoRoot = repoRootFromHere();
    if (needRepo || needWrapper) {
      if (tag) {
        const archive = path.join(tmp, "src.tgz");
        const url = `https://codeload.github.com/${REPO.owner}/${REPO.name}/tar.gz/refs/tags/${encodeURIComponent(
          tag
        )}`;
        process.stdout.write(`Downloading ${REPO.owner}/${REPO.name}@${tag}...\n`);
        await downloadToFile(url, archive);
        process.stdout.write("Extracting...\n");
        const extracted = path.join(tmp, "src");
        await extractTarGz(archive, extracted);
        repoRoot = extracted;
      } else {
        process.stdout.write("Offline mode: installing from local package contents.\n");
      }
    }

    const selectedModules = {};
    for (const pick of picks) {
      if (pick.kind === "module") selectedModules[pick.moduleName] = ((config && config.modules) || {})[pick.moduleName];
      if (pick.kind === "skill") {
        if (Object.prototype.hasOwnProperty.call((config && config.modules) || {}, pick.skillName)) {
          selectedModules[pick.skillName] = config.modules[pick.skillName];
        } else selectedModules[`skill:${pick.skillName}`] = { operations: [{ type: "copy_dir", source: `skills/${pick.skillName}`, target: `skills/${pick.skillName}` }] };
      }
    }
    requirePythonForHooks(pythonHookNames(selectedModules, repoRoot));

    await fs.promises.mkdir(installDir, { recursive: true });
    const installState = { wrapperInstalled: false };

    async function ensureWrapperInstalled() {
      if (installState.wrapperInstalled) return;
      process.stdout.write("Installing codeagent-wrapper...\n");
      await runInstallSh(repoRoot, installDir, tag, offline);
      installState.wrapperInstalled = true;
    }

    for (const p of picks) {
      if (p.kind === "wrapper") {
        await ensureWrapperInstalled();
        continue;
      }
      if (p.kind === "module") {
        if (WRAPPER_REQUIRED_MODULES.has(p.moduleName)) await ensureWrapperInstalled();
        process.stdout.write(`Installing module: ${p.moduleName}\n`);
        const r = await applyModule(
          p.moduleName,
          config,
          repoRoot,
          installDir,
          force,
          tag,
          installState,
          force,
          offline
        );
        r.version = tag || "offline";
        upsertModuleStatus(installDir, r);
        continue;
      }
      if (p.kind === "skill") {
        if (Object.prototype.hasOwnProperty.call((config && config.modules) || {}, p.skillName)) {
          const moduleName = p.skillName;
          if (WRAPPER_REQUIRED_MODULES.has(moduleName)) await ensureWrapperInstalled();
          process.stdout.write(`Skill ${p.skillName} matches module ${moduleName}; installing the module instead.\n`);
          const r = await applyModule(moduleName, config, repoRoot, installDir, force, tag,
            installState, force, offline);
          r.version = tag || "offline";
          upsertModuleStatus(installDir, r);
          continue;
        }
        if (WRAPPER_REQUIRED_SKILLS.has(p.skillName)) await ensureWrapperInstalled();
        process.stdout.write(`Installing skill: ${p.skillName}\n`);
        const skillSource = `skills/${p.skillName}`;
        const name = `skill:${p.skillName}`;
        const r = await applyModule(name, { modules: { [name]: { operations: [{ type: "copy_dir", source: skillSource, target: skillSource }] } } }, repoRoot, installDir, force, tag, installState, force, offline);
        upsertModuleStatus(installDir, { ...r, status: "installed", version: tag || "offline" });
      }
    }

    await installDefaultConfigs(installDir, repoRoot, withClaudeMd, ensureWrapperInstalled);
    printPostInstallInfo(installDir);
  } finally {
    await rmTree(tmp);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  skipWrapper = args.skipWrapper;
  if (args.help) {
    printHelp();
    return;
  }

  const installDir = resolveInstallDir(args.installDir);
  if (args.command !== "install" && args.command !== "uninstall") {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (args.list && args.update) throw new Error("Cannot combine --list and --update");

  if (!args.list && args.command !== "uninstall") validateInstallJson(installDir);

  if (args.command === "uninstall") {
    const config = readLocalConfig();
    const repoRoot = repoRootFromHere();
    const fromStatus = readInstalledModuleNamesFromStatus(installDir);
    const installed = fromStatus || (await detectInstalledModuleNames(config, repoRoot, installDir));
    const installedSet = new Set(installed);

    let toRemove = [];
    if (args.module) {
      const v = String(args.module).trim();
      if (v.toLowerCase() === "all") {
        toRemove = installed;
      } else {
        toRemove = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (args.yes) {
      toRemove = installed;
    } else {
      const modules = (config && config.modules) || {};
      const items = [];
      for (const [name, mod] of Object.entries(modules)) {
        if (!installedSet.has(name)) continue;
        const desc = mod && typeof mod.description === "string" ? mod.description : "";
        items.push({
          id: `module:${name}`,
          label: `module:${name}${desc ? ` - ${desc}` : ""}`,
          kind: "module",
          moduleName: name,
        });
      }
      for (const name of installed) {
        if (!name.startsWith("skill:")) continue;
        items.push({ id: name, label: name, kind: "skill", skillName: name.slice(6) });
      }
      if (!items.length) {
        process.stdout.write(`No installed modules found in ${installDir}.\n`);
        return;
      }
      const picks = await promptMultiSelect(items, "myclaude uninstall");
      toRemove = picks.map((p) => p.moduleName || p.id);
    }

    toRemove = toRemove.filter((m) => installedSet.has(m));
    if (!toRemove.length) {
      process.stdout.write("Nothing selected.\n");
      return;
    }

    if (!args.yes && !args.dryRun) {
      if (!process.stdin.isTTY) {
        throw new Error("No TTY. Use -y/--yes to skip confirmation.");
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => rl.question("Confirm uninstall? (y/N): ", resolve));
      rl.close();
      if (String(answer).trim().toLowerCase() !== "y") {
        process.stdout.write("Cancelled.\n");
        return;
      }
    }

    for (const name of toRemove) {
      process.stdout.write(`Uninstalling module: ${name}\n`);
      await uninstallModule(name, config, repoRoot, installDir, args.dryRun);
    }
    process.stdout.write("Done.\n");
    return;
  }

  let tag = args.tag;
  if (!tag && !args.offline) {
    try {
      tag = await withTimeout(fetchLatestTag(), 5000, "fetch latest tag");
    } catch (err) {
      process.stderr.write(`Warning: could not fetch latest tag (${err.message}); using bundled package content in offline mode.\n`);
      tag = null;
    }
  }

  let config = null;
  let skills = [];
  if (tag) {
    try {
      [config, skills] = await withTimeout(
        Promise.all([fetchRemoteConfig(tag), fetchRemoteSkills(tag)]),
        8000,
        "fetch config/skills"
      );
    } catch {
      config = null;
      skills = [];
    }
  }

  if (!config) config = readLocalConfig();
  if (!skills.length) skills = listLocalSkills();

  if (args.update) {
    await updateInstalledModules(installDir, tag, config, args.dryRun, args.force, args.offline, args.module);
    process.stdout.write("Done.\n");
    return;
  }

  const items = buildItems(config, skills);
  const installedEntries = loadInstalledStatus(installDir).modules;
  for (const item of items) {
    const key = item.kind === "module" ? item.moduleName : item.kind === "skill" ? `skill:${item.skillName}` : null;
    const entry = key && installedEntries[key];
    if (entry) item.label += ` [${entry.status === "partial_uninstall" ? "partially uninstalled" : "installed"}${entry.version ? ` ${entry.version}` : ""}]`;
  }
  if (args.list) {
    const installed = loadInstalledStatus(installDir).modules;
    for (const it of items) {
      const key = it.kind === "module" ? it.moduleName : it.kind === "skill" ? `skill:${it.skillName}` : null;
      const entry = key && installed[key];
      process.stdout.write(`${it.id}${entry ? ` (${entry.status === "partial_uninstall" ? "partially uninstalled" : "installed"}${entry.version ? `, ${entry.version}` : ""})` : ""}\n`);
    }
    return;
  }

  const title = tag ? `myclaude installer (latest: ${tag})` : "myclaude installer (offline mode)";
  const picks = await promptMultiSelect(items, title);
  if (!picks.length) {
    process.stdout.write("Nothing selected.\n");
    return;
  }

  await installSelected(picks, tag, config, installDir, args.force, args.dryRun, args.offline, args.withClaudeMd);
  process.stdout.write("Done.\n");
}

module.exports = {
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
  resolvePythonCommand,
  findPythonCommand,
  mergeHooksToSettings,
  unmergeHooksFromSettings,
  mergeModuleHooks,
  mergeModuleAgentsToModels,
  agentDefaultsHash,
  uninstallModule,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
