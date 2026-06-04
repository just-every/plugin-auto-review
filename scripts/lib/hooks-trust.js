"use strict";

const path = require("node:path");

const { AppServerJsonlClient } = require("./app-server-client");
const { resolveCodexHome } = require("./agent-setup");

const DEFAULT_PLUGIN_ID = "auto-review@just-every";

async function trustPluginHooks(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || env.INIT_CWD || process.env.INIT_CWD || process.cwd();
  const {
    pluginId = DEFAULT_PLUGIN_ID,
    codexPath,
    dryRun = false
  } = options;
  const codexHome = options.codexHome ? resolveCodexHome({ codexHome: options.codexHome }) : null;
  const resolvedCwd = path.resolve(cwd);
  const client = new AppServerJsonlClient({
    codexPath,
    codexHome,
    cwd: resolvedCwd,
    env
  });

  await client.start();
  try {
    const before = await listPluginHooks(client, resolvedCwd, pluginId);
    if (before.length === 0) {
      throw new Error(
        `No hooks for ${pluginId} were discovered for ${resolvedCwd}. Check that the plugin is installed and enabled for this CODEX_HOME.`
      );
    }

    const targetHooks = before.filter((hook) => !hook.isManaged);
    if (targetHooks.length === 0) {
      throw new Error(`All discovered hooks for ${pluginId} are managed; there is no user hook state to update.`);
    }

    const state = Object.fromEntries(
      targetHooks.map((hook) => [
        hook.key,
        {
          trusted_hash: hook.currentHash,
          enabled: true
        }
      ])
    );

    if (!dryRun) {
      await client.request("config/batchWrite", {
        edits: [
          {
            keyPath: "hooks.state",
            value: state,
            mergeStrategy: "upsert"
          }
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true
      });
    }

    const after = dryRun ? before : await listPluginHooks(client, resolvedCwd, pluginId);
    const afterByKey = new Map(after.map((hook) => [hook.key, hook]));
    const notReady = targetHooks
      .map((hook) => afterByKey.get(hook.key))
      .filter((hook) => !hook || hook.enabled !== true || hook.trustStatus !== "trusted");

    if (!dryRun && notReady.length > 0) {
      const details = notReady
        .map((hook) => hook ? `${hook.key} (${hook.trustStatus}, enabled=${hook.enabled})` : "missing hook")
        .join(", ");
      throw new Error(`Hook trust write completed, but verification did not pass: ${details}`);
    }

    const reportedCodexHome = codexHome
      || (env?.CODEX_HOME ? resolveCodexHome({ codexHome: env.CODEX_HOME }) : null)
      || (process.env.CODEX_HOME ? resolveCodexHome({ codexHome: process.env.CODEX_HOME }) : null)
      || resolveCodexHome();

    return {
      cwd: resolvedCwd,
      pluginId,
      codexHome: reportedCodexHome,
      dryRun,
      updatedCount: targetHooks.length,
      hooks: after.map(summarizeHook).sort((a, b) => a.displayOrder - b.displayOrder)
    };
  } finally {
    await client.close();
  }
}

async function listPluginHooks(client, cwd, pluginId) {
  const response = await client.request("hooks/list", { cwds: [cwd] });
  const entries = Array.isArray(response.data) ? response.data : [];
  return entries
    .flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
    .filter((hook) => hook.pluginId === pluginId)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

function summarizeHook(hook) {
  return {
    key: hook.key,
    eventName: hook.eventName,
    matcher: hook.matcher || null,
    enabled: hook.enabled,
    trustStatus: hook.trustStatus,
    displayOrder: hook.displayOrder
  };
}

module.exports = {
  DEFAULT_PLUGIN_ID,
  trustPluginHooks
};
