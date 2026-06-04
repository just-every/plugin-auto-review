"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveCodexHome } = require("../scripts/lib/codex-home");
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

  assert.strictEqual(result.updatedCount, 2);
  assert.deepStrictEqual(
    result.hooks.map((hook) => [hook.eventName, hook.trustStatus, hook.enabled]),
    [
      ["userPromptSubmit", "trusted", true],
      ["stop", "trusted", true]
    ]
  );

  const writes = readRequests(requestsPath).filter((request) => request.method === "config/batchWrite");
  assert.strictEqual(writes.length, 1);
  const edit = writes[0].params.edits[0];
  assert.strictEqual(edit.keyPath, "hooks.state");
  assert.strictEqual(edit.mergeStrategy, "upsert");
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
  assert.strictEqual(result.updatedCount, 2);
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
  assert.match(result.stdout, /Would trust and enable 2 auto-review@just-every hooks/);
  assert.doesNotMatch(result.stdout, /agent/i);
  assert.match(result.stdout, new RegExp(`CWD: ${escapeRegExp(cwd)}`));
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

test("setup installs plugin commands and trusts hooks", () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const cwd = tempDir("auto-review-cli-workspace-");
  const codexHome = tempDir("auto-review-codex-home-");
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
  assert.match(result.stdout, /Auto Code Review setup complete/);
  assert.match(result.stdout, /plugin marketplace add just-every\/plugins: completed/);
  assert.match(result.stdout, /plugin marketplace upgrade just-every: completed/);
  assert.match(result.stdout, /plugin add auto-review@just-every: completed/);
  assert.doesNotMatch(result.stdout, /agent/i);
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
  assert.deepStrictEqual(readCliCommands(cliCommands), [
    ["plugin", "add", "auto-review@local"]
  ]);
});

test("setup removes stale Auto Code Review custom agent config", () => {
  fs.chmodSync(MOCK_APP_SERVER_CODEX, 0o755);
  const cwd = tempDir("auto-review-cli-workspace-");
  const codexHome = tempDir("auto-review-codex-home-");
  const agentDir = path.join(codexHome, "agents");
  const agentFile = path.join(agentDir, "auto-review.toml");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    agentFile,
    [
      'name = "auto-review"',
      'description = "Visible Auto Code Review agent"',
      'developer_instructions = """',
      "Auto Code Review",
      '"""',
      ""
    ].join("\n"),
    "utf8"
  );

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
        MOCK_CODEX_CLI_COMMANDS: path.join(tempDir("auto-review-cli-commands-"), "commands.jsonl")
      },
      encoding: "utf8"
    }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /stale Auto Code Review custom agent: removed/);
  assert.strictEqual(fs.existsSync(agentFile), false);
});

test("resolveCodexHome expands tilde codex homes", () => {
  assert.strictEqual(resolveCodexHome({ codexHome: "~/.codex" }), path.join(os.homedir(), ".codex"));
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
