"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  autoReviewCommand,
  codexHomeFromPluginData,
  installAutoReviewAgent,
  installedPluginRoot,
  resolveCodexHome
} = require("../scripts/lib/agent-setup");
const { trustPluginHooks } = require("../scripts/lib/hooks-trust");
const { tempDir } = require("./helpers");

const MOCK_APP_SERVER_CODEX = path.join(__dirname, "fixtures", "mock-app-server-codex.js");

test("trustPluginHooks writes trusted hashes and enables plugin hooks", async () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const requestsPath = path.join(tempDir("auto-review-hooks-rpc-"), "requests.jsonl");

  const result = await trustPluginHooks({
    cwd: tempDir("auto-review-project-"),
    codexHome: "/tmp/auto-review-codex-home",
    codexPath: MOCK_APP_SERVER_CODEX,
    env: {
      ...process.env,
      MOCK_APP_SERVER_REQUESTS: requestsPath
    }
  });

  assert.strictEqual(result.updatedCount, 3);
  assert.deepStrictEqual(
    result.hooks.map((hook) => [hook.eventName, hook.trustStatus, hook.enabled]),
    [
      ["postToolUse", "trusted", true],
      ["userPromptSubmit", "trusted", true],
      ["stop", "trusted", true]
    ]
  );

  const writes = readRequests(requestsPath).filter((request) => request.method === "config/batchWrite");
  assert.strictEqual(writes.length, 1);
  const edit = writes[0].params.edits[0];
  assert.strictEqual(edit.keyPath, "hooks.state");
  assert.strictEqual(edit.mergeStrategy, "upsert");
  assert.deepStrictEqual(edit.value["auto-review@just-every:hooks/hooks.json:post_tool_use:0:0"], {
    trusted_hash: "sha256:post",
    enabled: true
  });
  assert.deepStrictEqual(edit.value["auto-review@just-every:hooks/hooks.json:user_prompt_submit:0:0"], {
    trusted_hash: "sha256:user",
    enabled: true
  });
  assert.deepStrictEqual(edit.value["auto-review@just-every:hooks/hooks.json:stop:0:0"], {
    trusted_hash: "sha256:stop",
    enabled: true
  });
});

test("trustPluginHooks dry-run lists updates without writing config", async () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const requestsPath = path.join(tempDir("auto-review-hooks-rpc-"), "requests.jsonl");

  const result = await trustPluginHooks({
    cwd: tempDir("auto-review-project-"),
    codexHome: "/tmp/auto-review-codex-home",
    codexPath: MOCK_APP_SERVER_CODEX,
    dryRun: true,
    env: {
      ...process.env,
      MOCK_APP_SERVER_REQUESTS: requestsPath
    }
  });

  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.updatedCount, 3);
  assert.strictEqual(
    readRequests(requestsPath).filter((request) => request.method === "config/batchWrite").length,
    0
  );
});

test("trustPluginHooks defaults to npm's invoking directory when available", async () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const invokingDir = tempDir("auto-review-invoking-workspace-");

  const result = await trustPluginHooks({
    codexHome: "/tmp/auto-review-codex-home",
    codexPath: MOCK_APP_SERVER_CODEX,
    dryRun: true,
    env: {
      ...process.env,
      INIT_CWD: invokingDir
    }
  });

  assert.strictEqual(result.cwd, invokingDir);
});

test("trust-hooks CLI accepts the npx-style trust-hooks subcommand", () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const cwd = tempDir("auto-review-cli-workspace-");
  const codexHome = tempDir("auto-review-codex-home-");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "trust-hooks.js"),
      "trust-hooks",
      "--dry-run",
      "--codex",
      MOCK_APP_SERVER_CODEX,
      "--codex-home",
      codexHome
    ],
    {
      cwd,
      env: {
        ...process.env,
        INIT_CWD: cwd
      },
      encoding: "utf8"
    }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /`trust-hooks` is kept for compatibility/);
  assert.match(result.stdout, /Would trust and enable 3 auto-review@just-every hooks/);
  assert.match(result.stdout, /Would install Auto Code Review agent/);
  assert.match(result.stdout, new RegExp(`CWD: ${escapeRegExp(cwd)}`));
  assert.strictEqual(fs.existsSync(path.join(codexHome, "agents", "auto-review.toml")), false);
});

test("trust-hooks CLI without a subcommand remains trust-only", () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const cwd = tempDir("auto-review-cli-workspace-");
  const codexHome = tempDir("auto-review-codex-home-");
  const cliCommands = path.join(tempDir("auto-review-cli-commands-"), "commands.jsonl");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "trust-hooks.js"),
      "--dry-run",
      "--codex",
      MOCK_APP_SERVER_CODEX,
      "--codex-home",
      codexHome
    ],
    {
      cwd,
      env: {
        ...process.env,
        INIT_CWD: cwd,
        MOCK_CODEX_CLI_COMMANDS: cliCommands
      },
      encoding: "utf8"
    }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /`trust-hooks` is kept for compatibility/);
  assert.strictEqual(fs.existsSync(cliCommands), false);
});

test("trust-hooks CLI installs the Auto Code Review custom agent", () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const cwd = tempDir("auto-review-cli-workspace-");
  const codexHome = tempDir("auto-review-codex-home-");
  const pluginRoot = createPluginCache(codexHome, "auto-review@just-every", "9.9.9");
  const cliCommands = path.join(tempDir("auto-review-cli-commands-"), "commands.jsonl");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "trust-hooks.js"),
      "setup",
      "--codex",
      MOCK_APP_SERVER_CODEX,
      "--codex-home",
      codexHome
    ],
    {
      cwd,
      env: {
        ...process.env,
        INIT_CWD: cwd,
        MOCK_CODEX_CLI_COMMANDS: cliCommands
      },
      encoding: "utf8"
    }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  const agentPath = path.join(codexHome, "agents", "auto-review.toml");
  assert.match(result.stdout, /Auto Code Review setup complete/);
  assert.match(result.stdout, /plugin marketplace add just-every\/plugins: completed/);
  assert.match(result.stdout, /plugin marketplace upgrade just-every: completed/);
  assert.match(result.stdout, /plugin add auto-review@just-every: completed/);
  assert.match(result.stdout, /Installed Auto Code Review agent/);
  const agentToml = fs.readFileSync(agentPath, "utf8");
  assert.match(agentToml, /name = "auto-review"/);
  assert.match(agentToml, /nickname_candidates = \["Auto Code Review"\]/);
  assert.match(agentToml, new RegExp(`${escapeRegExp(pluginRoot)}.*scripts/autoreview\\.js`));
  assert.match(agentToml, /--cwd "\$PWD"/);
  assert.match(agentToml, /--checkpoint-id <id>/);
  assert.match(agentToml, /Repository cwd: <path>/);
  assert.match(agentToml, /replace `"\$PWD"`/);
  assert.doesNotMatch(agentToml, /\$autoreview/);
  assert.deepStrictEqual(readCliCommands(cliCommands), [
    ["plugin", "marketplace", "add", "just-every/plugins"],
    ["plugin", "marketplace", "upgrade", "just-every"],
    ["plugin", "add", "auto-review@just-every"]
  ]);
});

test("setup with custom plugin id installs and trusts that plugin only", () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const cwd = tempDir("auto-review-cli-workspace-");
  const codexHome = tempDir("auto-review-codex-home-");
  createPluginCache(codexHome, "auto-review@local", "1.0.0");
  const cliCommands = path.join(tempDir("auto-review-cli-commands-"), "commands.jsonl");
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "trust-hooks.js"),
      "setup",
      "--plugin-id",
      "auto-review@local",
      "--codex",
      MOCK_APP_SERVER_CODEX,
      "--codex-home",
      codexHome
    ],
    {
      cwd,
      env: {
        ...process.env,
        INIT_CWD: cwd,
        MOCK_APP_SERVER_PLUGIN_ID: "auto-review@local",
        MOCK_CODEX_CLI_COMMANDS: cliCommands
      },
      encoding: "utf8"
    }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /plugin add auto-review@local: completed/);
  assert.doesNotMatch(result.stdout, /marketplace add/);
  const agentToml = fs.readFileSync(path.join(codexHome, "agents", "auto-review.toml"), "utf8");
  assert.match(agentToml, new RegExp(`${escapeRegExp(codexHome)}/plugins/data/auto-review-local`));
  assert.deepStrictEqual(readCliCommands(cliCommands), [
    ["plugin", "add", "auto-review@local"]
  ]);
});

test("Auto Code Review agent setup expands tilde codex homes", () => {
  assert.strictEqual(resolveCodexHome({ codexHome: "~/.codex" }), path.join(os.homedir(), ".codex"));
});

test("Auto Code Review command defaults plugin data from codex home", () => {
  const codexHome = tempDir("auto-review-codex-home-");
  const command = autoReviewCommand({ codexHome, pluginRoot: "/tmp/plugin-root" });
  assert.match(command, new RegExp(`${escapeRegExp(codexHome)}/plugins/data/auto-review-just-every`));
});

test("Auto Code Review agent install defaults plugin data from codex home", () => {
  const codexHome = tempDir("auto-review-codex-home-");
  const pluginRoot = createPluginCache(codexHome, "auto-review@just-every", "4.0.0");
  const result = installAutoReviewAgent({ codexHome, pluginRoot });
  assert.strictEqual(result.installed, true);
  const agentToml = fs.readFileSync(path.join(codexHome, "agents", "auto-review.toml"), "utf8");
  assert.match(agentToml, new RegExp(`${escapeRegExp(codexHome)}/plugins/data/auto-review-just-every`));
  assert.match(agentToml, new RegExp(`${escapeRegExp(pluginRoot)}.*scripts/autoreview\\.js`));
});

test("Auto Code Review agent install requires a stable plugin root", () => {
  const codexHome = tempDir("auto-review-codex-home-");
  assert.throws(
    () => installAutoReviewAgent({ codexHome }),
    /pluginRoot is required/
  );
});

test("Auto Code Review agent setup derives codex home from plugin data", () => {
  const codexHome = path.join(os.tmpdir(), "codex-home");
  assert.strictEqual(
    codexHomeFromPluginData(path.join(codexHome, "plugins", "data", "auto-review-just-every")),
    codexHome
  );
  assert.strictEqual(
    codexHomeFromPluginData(path.join(codexHome, "plugins", "data", "auto-review-just-every", "turns", "session")),
    codexHome
  );
});

test("Auto Code Review setup resolves the installed plugin cache root", () => {
  const codexHome = tempDir("auto-review-codex-home-");
  const oldRoot = createPluginCache(codexHome, "auto-review@just-every", "1.0.0");
  const newRoot = createPluginCache(codexHome, "auto-review@just-every", "2.0.0");
  fs.utimesSync(oldRoot, new Date(1), new Date(1));
  fs.utimesSync(newRoot, new Date(2), new Date(2));
  assert.strictEqual(installedPluginRoot(codexHome, "auto-review@just-every"), newRoot);
});

test("Auto Code Review setup waits briefly for plugin cache materialization", () => {
  const codexHome = tempDir("auto-review-codex-home-");
  const root = path.join(codexHome, "plugins", "cache", "just-every", "auto-review");
  let calls = 0;
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = function patchedReaddirSync(target, options) {
    if (target === root && calls++ === 0) {
      createPluginCache(codexHome, "auto-review@just-every", "3.0.0");
      const error = new Error("not ready");
      error.code = "ENOENT";
      throw error;
    }
    return originalReaddirSync.call(this, target, options);
  };
  const startedAt = Date.now();
  try {
    const resolved = installedPluginRoot(codexHome, "auto-review@just-every", { attempts: 3, delayMs: 25 });
    assert.ok(Date.now() - startedAt >= 20);
    assert.match(resolved, /3\.0\.0$/);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test("trustPluginHooks fails when the plugin hooks are not installed", async () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  await assert.rejects(
    () =>
      trustPluginHooks({
        cwd: tempDir("auto-review-project-"),
        codexHome: "/tmp/auto-review-codex-home",
        codexPath: MOCK_APP_SERVER_CODEX,
        env: {
          ...process.env,
          MOCK_APP_SERVER_NO_HOOKS: "1"
        }
      }),
    /No hooks for auto-review@just-every were discovered/
  );
});

function readRequests(file) {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readCliCommands(file) {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createPluginCache(codexHome, pluginId, version) {
  const [pluginName, marketplaceName] = pluginId.split("@");
  const root = path.join(codexHome, "plugins", "cache", marketplaceName, pluginName, version);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "autoreview.js"), "#!/usr/bin/env node\n", "utf8");
  return root;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
