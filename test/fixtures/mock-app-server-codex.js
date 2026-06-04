#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

if (process.argv[2] !== "app-server" || process.argv[3] !== "--listen" || process.argv[4] !== "stdio://") {
  if (process.env.MOCK_CODEX_CLI_COMMANDS) {
    fs.appendFileSync(process.env.MOCK_CODEX_CLI_COMMANDS, `${JSON.stringify(process.argv.slice(2))}\n`, "utf8");
  }
  if (process.env.MOCK_CODEX_CLI_FAIL === "1") {
    process.stderr.write("mock codex cli failure\n");
    process.exit(1);
  }
  process.exit(0);
}

const requestsPath = process.env.MOCK_APP_SERVER_REQUESTS;
const pluginId = process.env.MOCK_APP_SERVER_PLUGIN_ID || "auto-review@just-every";
const hooks = process.env.MOCK_APP_SERVER_NO_HOOKS === "1" ? [] : createHooks();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (requestsPath) {
    fs.appendFileSync(requestsPath, `${JSON.stringify(message)}\n`, "utf8");
  }
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    send(message.id, {
      userAgent: "mock",
      codexHome: process.env.CODEX_HOME || "/tmp/mock-codex-home",
      platformFamily: "unix",
      platformOs: "macos"
    });
    return;
  }
  if (message.method === "hooks/list") {
    send(message.id, {
      data: [
        {
          cwd: message.params.cwds[0],
          hooks,
          warnings: [],
          errors: []
        }
      ]
    });
    return;
  }
  if (message.method === "config/batchWrite") {
    if (process.env.MOCK_APP_SERVER_WRITE_FAIL === "1") {
      sendError(message.id, "mock write failed");
      return;
    }
    applyConfigWrite(message.params);
    send(message.id, {});
    return;
  }

  sendError(message.id, `unknown method: ${message.method}`);
});

function createHooks() {
  const trusted = process.env.MOCK_APP_SERVER_ALREADY_TRUSTED === "1";
  return [
    hook("user_prompt_submit", "userPromptSubmit", null, "sha256:user", 0, trusted),
    hook("stop", "stop", null, "sha256:stop", 1, trusted)
  ];
}

function hook(keyEvent, eventName, matcher, currentHash, displayOrder, trusted) {
  return {
    key: `${pluginId}:hooks/hooks.json:${keyEvent}:0:0`,
    eventName,
    handlerType: "command",
    matcher,
    command: `node /mock/${keyEvent}.js`,
    timeoutSec: 600,
    statusMessage: null,
    sourcePath: "/mock/hooks/hooks.json",
    source: "plugin",
    pluginId,
    displayOrder,
    enabled: trusted ? true : displayOrder !== 2,
    isManaged: false,
    currentHash,
    trustStatus: trusted ? "trusted" : "untrusted"
  };
}

function applyConfigWrite(params) {
  for (const edit of params.edits || []) {
    if (edit.keyPath !== "hooks.state") continue;
    for (const [key, state] of Object.entries(edit.value || {})) {
      const target = hooks.find((candidate) => candidate.key === key);
      if (!target) continue;
      if (state.trusted_hash === target.currentHash) {
        target.trustStatus = "trusted";
      }
      if (typeof state.enabled === "boolean") {
        target.enabled = state.enabled;
      }
    }
  }
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function sendError(id, message) {
  process.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
}
