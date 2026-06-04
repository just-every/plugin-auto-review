"use strict";

const childProcess = require("node:child_process");

const { resolveCodexHome } = require("./agent-setup");
const { DEFAULT_PLUGIN_ID } = require("./hooks-trust");

const PLUGIN_INSTALL_STEPS = [
  ["plugin", "marketplace", "add", "just-every/plugins"],
  ["plugin", "marketplace", "upgrade", "just-every"],
  ["plugin", "add", "auto-review@just-every"]
];

function installAutoReviewPlugin(options = {}) {
  const pluginId = options.pluginId || DEFAULT_PLUGIN_ID;
  const codexPath = options.codexPath || process.env.CODEX_CLI_PATH || "codex";
  const cwd = options.cwd || process.cwd();
  const env = {
    ...process.env,
    ...(options.env || {})
  };
  if (options.codexHome) {
    env.CODEX_HOME = resolveCodexHome({ codexHome: options.codexHome });
  }

  const steps = pluginInstallSteps(pluginId).map((args) => ({
    command: [codexPath, ...args].join(" "),
    args,
    status: options.dryRun ? "skipped-dry-run" : "pending"
  }));

  if (options.dryRun) {
    return steps;
  }

  for (const step of steps) {
    const result = childProcess.spawnSync(codexPath, step.args, {
      cwd,
      env,
      encoding: "utf8"
    });
    step.status = result.status === 0 ? "completed" : "failed";
    step.stdout = result.stdout || "";
    step.stderr = result.stderr || "";
    if (result.status !== 0) {
      throw new Error(`${step.command} failed: ${step.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
    }
  }

  return steps;
}

function pluginInstallSteps(pluginId = DEFAULT_PLUGIN_ID) {
  if (pluginId !== DEFAULT_PLUGIN_ID) {
    return [["plugin", "add", pluginId]];
  }
  return PLUGIN_INSTALL_STEPS;
}

module.exports = {
  PLUGIN_INSTALL_STEPS,
  installAutoReviewPlugin,
  pluginInstallSteps
};
