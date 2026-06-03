#!/usr/bin/env node
"use strict";

const { DEFAULT_PLUGIN_ID, trustPluginHooks } = require("./lib/hooks-trust");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await trustPluginHooks(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatReport(result));
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
    `${action} ${result.updatedCount} ${result.pluginId} hook${result.updatedCount === 1 ? "" : "s"}.`,
    `CODEX_HOME: ${result.codexHome}`,
    `CWD: ${result.cwd}`
  ];
  for (const hook of result.hooks) {
    const matcher = hook.matcher ? ` matcher=${hook.matcher}` : "";
    lines.push(`- ${hook.eventName}${matcher}: ${hook.trustStatus}, enabled=${hook.enabled}`);
  }
  return `${lines.join("\n")}\n`;
}

function helpText() {
  return `Usage: node scripts/trust-hooks.js [options]

Trust and enable Auto Review plugin hooks for a Codex home.

Options:
  --cwd <path>          Project cwd used to discover effective hooks (default: current directory)
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
