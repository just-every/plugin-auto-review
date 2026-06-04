"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENT_FILE = "auto-review.toml";
const DEFAULT_PLUGIN_ID = "auto-review@just-every";

function resolveCodexHome(options = {}) {
  return path.resolve(expandHome(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (typeof value === "string" && value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function autoReviewAgentPath(codexHome) {
  return path.join(codexHome, "agents", AGENT_FILE);
}

function codexHomeFromPluginData(pluginData) {
  if (!pluginData) return null;
  let current = path.resolve(pluginData);
  while (current && current !== path.dirname(current)) {
    const dataDir = path.dirname(current);
    const pluginsDir = path.dirname(dataDir);
    if (path.basename(dataDir) === "data" && path.basename(pluginsDir) === "plugins") {
      return path.dirname(pluginsDir);
    }
    current = dataDir;
  }
  return null;
}

function autoReviewAgentInstalled(options = {}) {
  const codexHome = resolveCodexHome(options);
  const file = autoReviewAgentPath(codexHome);
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.includes('name = "auto-review"');
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function installAutoReviewAgent(options = {}) {
  const codexHome = resolveCodexHome(options);
  const file = autoReviewAgentPath(codexHome);
  const content = autoReviewAgentContent({ ...options, codexHome });
  let previous = null;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const changed = previous !== content;
  if (!options.dryRun && changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  return {
    codexHome,
    path: file,
    changed,
    installed: !options.dryRun && fs.existsSync(file),
    dryRun: Boolean(options.dryRun)
  };
}

function autoReviewAgentContent(options = {}) {
  const codexHome = resolveCodexHome(options);
  const pluginData = options.pluginData || pluginDataDir(codexHome, options.pluginId);
  const pluginRoot = options.pluginRoot || (options.dryRun ? "<installed-plugin-root>" : null);
  if (!pluginRoot) {
    throw new Error("pluginRoot is required to write the Auto Code Review agent command");
  }
  return autoReviewAgentToml({
    command: checkpointCommand({
      ...options,
      codexHome,
      pluginData,
      pluginRoot
    })
  });
}

function pluginDataDir(codexHome, pluginId = DEFAULT_PLUGIN_ID) {
  return path.join(codexHome, "plugins", "data", pluginId.replace("@", "-").replace(/[^A-Za-z0-9._-]/g, "-"));
}

function installedPluginRoot(codexHome, pluginId = DEFAULT_PLUGIN_ID, options = {}) {
  const attempts = options.attempts || 1;
  const delayMs = options.delayMs || 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = findInstalledPluginRoot(codexHome, pluginId);
    if (found || attempt === attempts - 1) return found;
    sleep(delayMs);
  }
  return null;
}

function findInstalledPluginRoot(codexHome, pluginId = DEFAULT_PLUGIN_ID) {
  const [pluginName, marketplaceName] = parsePluginId(pluginId);
  if (!pluginName || !marketplaceName) return null;
  const root = path.join(codexHome, "plugins", "cache", marketplaceName, pluginName);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name);
        return { dir, mtimeMs: fs.statSync(dir).mtimeMs };
      });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.dir.localeCompare(a.dir));
  return entries[0]?.dir || null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parsePluginId(pluginId) {
  const [pluginName, marketplaceName] = String(pluginId || "").split("@");
  return [pluginName, marketplaceName];
}

function checkpointCommand(options = {}) {
  const codexHome = resolveCodexHome(options);
  const pluginRoot = path.resolve(options.pluginRoot || path.join(__dirname, "..", ".."));
  const pluginData = path.resolve(options.pluginData || pluginDataDir(codexHome, options.pluginId));
  const cwd = options.cwd ? shellQuote(path.resolve(options.cwd)) : "\"$PWD\"";
  return [
    shellQuote(process.execPath),
    shellQuote(path.join(pluginRoot, "scripts", "checkpoint.js")),
    "context",
    "--plugin-data",
    shellQuote(pluginData),
    "--cwd",
    cwd
  ].join(" ");
}

function shellQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

function autoReviewAgentToml(options = {}) {
  const command = options.command || checkpointCommand({
    pluginData: pluginDataDir(resolveCodexHome())
  });
  return `name = "auto-review"
description = "Visible Auto Code Review agent that reviews persisted checkpoints and reports findings without editing repo files."
model = "gpt-5.5"
model_reasoning_effort = "medium"
sandbox_mode = "workspace-write"
nickname_candidates = ["Auto Code Review"]

developer_instructions = """
You are the Auto Code Review subagent for Codex.

Your job is to review checkpoints produced by the Auto Code Review plugin.
You are the reviewer. Do not delegate review to another command, another model,
or another agent. Do not edit repository files, do not apply fixes, and do not
start additional agents.

When the parent asks you to review a checkpoint, run this command only to load
the checkpoint context:

${command}

If the parent message includes a checkpoint id, append \`--checkpoint-id <id>\`
to the command.

If the parent message includes \`Repository cwd: <path>\`, replace \`"$PWD"\`
in the command with the quoted repository cwd path from the parent message.

Review the changed paths and diff printed by that command. Report findings
directly in your own response to the parent thread. Prioritize correctness,
behavioral regressions, broken contracts, unsafe behavior, and missing edge-case
handling. Do not report style-only issues.

After you report the review result, run exactly one receipt command from the
checkpoint context. The receipt records only whether this checkpoint was reviewed;
it must not contain the review findings. If the context command fails, report
stderr and the exit code to the parent thread.
"""
`;
}

module.exports = {
  autoReviewAgentToml,
  autoReviewAgentContent,
  autoReviewAgentInstalled,
  autoReviewAgentPath,
  codexHomeFromPluginData,
  checkpointCommand,
  installAutoReviewAgent,
  installedPluginRoot,
  pluginDataDir,
  resolveCodexHome
};
