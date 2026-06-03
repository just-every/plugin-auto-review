"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
