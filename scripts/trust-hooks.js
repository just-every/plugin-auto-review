#!/usr/bin/env node
"use strict";

const { DEFAULT_PLUGIN_ID, trustPluginHooks } = require("./lib/hooks-trust");
const { removeStaleAutoReviewAgent } = require("./lib/stale-agent-cleanup");
const { installAutoReviewPlugin } = require("./lib/plugin-install");

async function main() {
  const { command, args } = normalizeArgs(process.argv.slice(2));
  const options = parseArgs(args);
  options.command = command;
  const result = await setupAutoReview(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatReport(result));
}

function normalizeArgs(args) {
  if (args[0] === "trust-hooks" || args[0] === "setup") {
    return { command: args[0], args: args.slice(1) };
  }
  return { command: "trust-hooks", args };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(helpText());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--plugin-id") {
      options.pluginId = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--codex") {
      options.codexPath = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--codex-home") {
      options.codexHome = requireValue(args, (index += 1), arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function setupAutoReview(options) {
  const pluginInstall = options.command === "setup"
    ? installAutoReviewPlugin(options)
    : [];
  const hooks = await trustPluginHooks(options);
  const staleAgent = options.command === "setup"
    ? removeStaleAutoReviewAgent({ codexHome: hooks.codexHome, dryRun: options.dryRun })
    : null;
  return {
    ...hooks,
    command: options.command,
    pluginInstall,
    staleAgent
  };
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function formatReport(result) {
  const action = result.dryRun ? "Would trust and enable" : "Trusted and enabled";
  const lines = [
    result.command === "trust-hooks"
      ? "`trust-hooks` is kept for compatibility; use `setup` for full installation."
      : "Auto Code Review setup complete.",
    `${action} ${result.updatedCount} ${result.pluginId} hook${result.updatedCount === 1 ? "" : "s"}.`,
    `CODEX_HOME: ${result.codexHome}`,
    `CWD: ${result.cwd}`
  ];
  for (const step of result.pluginInstall || []) {
    lines.push(`- ${step.command}: ${step.status}`);
  }
  if (result.staleAgent && result.staleAgent.status !== "absent") {
    lines.push(`- stale Auto Code Review custom agent: ${result.staleAgent.status}`);
  }
  for (const hook of result.hooks) {
    const matcher = hook.matcher ? ` matcher=${hook.matcher}` : "";
    lines.push(`- ${hook.eventName}${matcher}: ${hook.trustStatus}, enabled=${hook.enabled}`);
  }
  return `${lines.join("\n")}\n`;
}

function helpText() {
  return `Usage: plugin-auto-review setup [options]
       plugin-auto-review trust-hooks [options]

setup installs the marketplace/plugin, trusts and enables hooks, then removes stale custom agent config.
trust-hooks is kept for compatibility and only runs hook trust.

Options:
  --cwd <path>          Project cwd used to discover effective hooks (default: npm's invoking directory, then current directory)
  --plugin-id <id>      Plugin id to trust (default: ${DEFAULT_PLUGIN_ID})
  --codex-home <path>   Codex home to update (default: CODEX_HOME or ~/.codex)
  --codex <path>        Codex executable (default: CODEX_CLI_PATH or codex)
  --dry-run             List the hook updates without writing config
  --json                Print machine-readable output
  -h, --help            Show this help
`;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
