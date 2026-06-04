"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { installAutoReviewAgent } = require("../scripts/lib/agent-setup");
const { checkpointIdForSnapshot } = require("../scripts/lib/checkpoints");
const { createRepo, hookInput, prepareEditedTurn, runHook, tempDir } = require("./helpers");

const ROOT = path.resolve(__dirname, "..");

test("UserPromptSubmit captures a baseline snapshot", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const result = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  const baselineFiles = findFiles(pluginData, "baseline.json");
  assert.strictEqual(baselineFiles.length, 1);
  const baseline = JSON.parse(fs.readFileSync(baselineFiles[0], "utf8"));
  assert.ok(baseline.files.some((file) => file.path === "src/app.js"));
});

test("UserPromptSubmit fails open when baseline persistence fails", () => {
  const repo = createRepo();
  const pluginDataFile = path.join(tempDir("auto-review-data-file-"), "data");
  fs.writeFileSync(pluginDataFile, "not a directory\n", "utf8");

  const result = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginDataFile
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
});

test("UserPromptSubmit keeps configuration failures visible", () => {
  const repo = createRepo();

  const result = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: ""
  });

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /PLUGIN_DATA is required/);
});

test("PostToolUse records only apply_patch edit markers", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const ignored = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      tool_name: "Bash",
      tool_use_id: "tool-shell",
      tool_input: {},
      tool_response: {}
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(ignored.status, 0, ignored.stderr);
  assert.strictEqual(findFiles(pluginData, "tool-shell.json").length, 0);

  const marked = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      tool_name: "apply_patch",
      tool_use_id: "tool-patch",
      tool_input: { arguments: { noisy: "payload" } },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(marked.status, 0, marked.stderr);
  assert.deepStrictEqual(marked.json, { continue: true });
  const markerFiles = findFiles(pluginData, ".json").filter((file) => file.includes("markers"));
  assert.strictEqual(markerFiles.length, 1);
  const marker = JSON.parse(fs.readFileSync(markerFiles[0], "utf8"));
  assert.strictEqual(marker.tool_name, "apply_patch");
  assert.strictEqual(marker.tool_use_id, "tool-patch");
  assert.ok(!Object.hasOwn(marker, "tool_input"));
  assert.ok(!Object.hasOwn(marker, "tool_response"));
});

test("PostToolUse fails open when marker persistence fails", () => {
  const repo = createRepo();
  const pluginDataFile = path.join(tempDir("auto-review-data-file-"), "data");
  fs.writeFileSync(pluginDataFile, "not a directory\n", "utf8");

  const result = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      tool_name: "apply_patch",
      tool_use_id: "tool-patch",
      tool_input: {
        arguments: {
          ["x".repeat(800)]: "oversized property names should never break the parent turn"
        }
      },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginDataFile }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
});

test("PostToolUse keeps hook contract failures visible", () => {
  const repo = createRepo();

  const result = runHook(
    "post-tool-use.js",
    hookInput("UserPromptSubmit", repo, {
      tool_name: "apply_patch",
      tool_use_id: "tool-patch"
    })
  );

  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /expected PostToolUse hook input/);
});

test("Stop skips turns that have no edit markers", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const result = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
});

test("Stop reviews changed snapshots even when the edit marker is missing", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");
  const result = runStop(repo, pluginData);

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Auto Code Review checkpoint/);
});

test("Stop writes checkpoint and blocks with Auto Code Review agent instructions", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const codexHome = tempDir("auto-review-codex-home-");
  const pluginRoot = createPluginCache(codexHome);
  installAutoReviewAgent({ codexHome, pluginData, pluginRoot });
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { CODEX_HOME: codexHome });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Auto Code Review checkpoint/);
  assert.match(result.json.reason, /Ask the `auto-review` subagent/);
  assert.match(result.json.reason, /Review Auto Code Review checkpoint [a-f0-9]{16}/);
  assert.match(result.json.reason, /Do not run the code review in this main thread/);
  assert.doesNotMatch(result.json.reason, /\$autoreview/);
  assert.doesNotMatch(result.json.reason, /scripts\/autoreview\.js/);
  assert.strictEqual(findFiles(pluginData, "request.json").length, 1);
  assert.ok(fs.existsSync(path.join(codexHome, "agents", "auto-review.toml")));
});

test("checkpoint ids are lowercase hex", () => {
  const checkpointId = checkpointIdForSnapshot("snapshot-key", {
    session_id: "session-1",
    turn_id: "turn-1"
  });
  assert.match(checkpointId, /^[a-f0-9]{16}$/);
});

test("Stop installs a missing Auto Code Review agent and asks for reload", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const codexHome = tempDir("auto-review-codex-home-");
  createPluginCache(codexHome);
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { CODEX_HOME: codexHome });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Installed the Auto Code Review subagent/);
  assert.match(result.json.reason, /Reopen Codex/);
  assert.doesNotMatch(result.json.reason, /Ask the `auto-review` subagent/);
  assert.doesNotMatch(result.json.reason, /npx -y @just-every\/plugin-auto-review setup/);
  assert.doesNotMatch(result.json.reason, /\$autoreview/);
  assert.match(result.json.reason, /spawn a default subagent/);
  assert.match(result.json.reason, /scripts\/checkpoint\.js/);
  assert.match(result.json.reason, /--checkpoint-id [a-f0-9]{16}/);
  assert.match(result.json.reason, /review this checkpoint itself/);
  assert.ok(fs.existsSync(path.join(codexHome, "agents", "auto-review.toml")));
});

test("Stop asks for reload when an installed agent config changes", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const codexHome = tempDir("auto-review-codex-home-");
  createPluginCache(codexHome);
  fs.mkdirSync(path.join(codexHome, "agents"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "agents", "auto-review.toml"), 'name = "auto-review"\nold = true\n', "utf8");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { CODEX_HOME: codexHome });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /updated its subagent configuration/);
  assert.match(result.json.reason, /Reopen Codex/);
  assert.doesNotMatch(result.json.reason, /Ask the `auto-review` subagent/);
  assert.doesNotMatch(result.json.reason, /Review Auto Code Review checkpoint [a-f0-9]{16}/);
  assert.match(result.json.reason, /spawn a default subagent/);
  assert.match(result.json.reason, /scripts\/checkpoint\.js/);
  assert.match(result.json.reason, /--checkpoint-id [a-f0-9]{16}/);
});

test("checkpoint context prints the diff and marks the checkpoint running", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");
  const checkpointId = checkpointIdFromReason(first.json.reason);

  const context = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(context.status, 0, context.stderr);
  assert.match(context.stdout, new RegExp(`Auto Code Review checkpoint ${checkpointId}`));
  assert.match(context.stdout, /Changed paths:\n- src\/app\.js/);
  assert.match(context.stdout, /module\.exports = 2/);
  assert.match(context.stdout, /Do not run another review tool/);
  assert.match(context.stdout, /checkpoint\.js" complete/);

  const request = JSON.parse(fs.readFileSync(findFiles(pluginData, "request.json")[0], "utf8"));
  assert.strictEqual(request.status, "running");
});

test("checkpoint clean receipt lets Stop finish", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");
  const checkpointId = checkpointIdFromReason(first.json.reason);

  const clean = runCheckpoint(repo, pluginData, ["complete", "--checkpoint-id", checkpointId, "--status", "clean"]);
  assert.strictEqual(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Recorded clean Auto Code Review receipt/);
  const receipt = JSON.parse(fs.readFileSync(findFiles(pluginData, "review-receipt.json")[0], "utf8"));
  assert.strictEqual(receipt.status, "clean");
  assert.strictEqual(receipt.checkpointId, checkpointId);

  const cleanStop = runStop(repo, pluginData);
  assert.strictEqual(cleanStop.status, 0, cleanStop.stderr);
  assert.strictEqual(cleanStop.json.continue, true);
  assert.match(cleanStop.json.systemMessage, /found no issues/);
});

test("checkpoint findings receipt blocks Stop without replaying findings", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");
  const checkpointId = checkpointIdFromReason(first.json.reason);

  const findings = runCheckpoint(repo, pluginData, [
    "complete",
    "--checkpoint-id",
    checkpointId,
    "--status",
    "findings",
    "--finding-count",
    "2",
    "--summary",
    "Broken behavior was reported by the subagent."
  ]);
  assert.strictEqual(findings.status, 0, findings.stderr);

  const second = runStop(repo, pluginData);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.json.decision, "block");
  assert.match(second.json.reason, /Auto Code Review reported 2 issues for this checkpoint/);
  assert.match(second.json.reason, /Auto Code Review subagent result/);
  assert.doesNotMatch(second.json.reason, /Broken behavior/);
});

test("active Stop continuations enforce findings receipts without replaying findings", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  const checkpointId = checkpointIdFromReason(first.json.reason);

  const findings = runCheckpoint(repo, pluginData, [
    "complete",
    "--checkpoint-id",
    checkpointId,
    "--status",
    "findings",
    "--finding-count",
    "1",
    "--summary",
    "Subagent reported a concrete finding."
  ]);
  assert.strictEqual(findings.status, 0, findings.stderr);

  const continuation = runStop(repo, pluginData, {}, { stop_hook_active: true });
  assert.strictEqual(continuation.status, 0, continuation.stderr);
  assert.strictEqual(continuation.json.decision, "block");
  assert.match(continuation.json.reason, /Auto Code Review reported 1 issue/);
  assert.doesNotMatch(continuation.json.reason, /concrete finding/);
});

test("checkpoint failed receipt is enforced by the next Stop", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  const checkpointId = checkpointIdFromReason(first.json.reason);

  const failed = runCheckpoint(repo, pluginData, [
    "complete",
    "--checkpoint-id",
    checkpointId,
    "--status",
    "failed",
    "--summary",
    "Subagent could not read the diff."
  ]);
  assert.strictEqual(failed.status, 0, failed.stderr);

  const second = runStop(repo, pluginData);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.json.decision, "block");
  assert.match(second.json.reason, /could not complete this checkpoint/);
  assert.doesNotMatch(second.json.reason, /could not read the diff/);
});

test("Stop ignores stale clean receipts after the snapshot changes", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");
  const firstCheckpointId = checkpointIdFromReason(first.json.reason);

  const clean = runCheckpoint(repo, pluginData, ["complete", "--checkpoint-id", firstCheckpointId, "--status", "clean"]);
  assert.strictEqual(clean.status, 0, clean.stderr);
  const cleanStop = runStop(repo, pluginData);
  assert.strictEqual(cleanStop.json.continue, true);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 3;\n", "utf8");
  const changedStop = runStop(repo, pluginData);
  assert.strictEqual(changedStop.status, 0, changedStop.stderr);
  assert.strictEqual(changedStop.json.decision, "block");
  assert.match(changedStop.json.reason, /Auto Code Review checkpoint/);
  assert.notStrictEqual(checkpointIdFromReason(changedStop.json.reason), firstCheckpointId);
});

test("checkpoint latest ignores completed checkpoints when another session is pending", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repo, pluginData, {
    sessionId: "session-old",
    turnId: "turn-old",
    content: "module.exports = 2;\n",
    toolUseId: "tool-old"
  });
  const oldStop = runStop(repo, pluginData, {}, { session_id: "session-old", turn_id: "turn-old" });
  assert.strictEqual(oldStop.json.decision, "block");
  const oldCheckpointId = checkpointIdFromReason(oldStop.json.reason);

  markEditedTurn(repo, pluginData, {
    sessionId: "session-new",
    turnId: "turn-new",
    content: "module.exports = 3;\n",
    toolUseId: "tool-new"
  });
  const newStop = runStop(repo, pluginData, {}, { session_id: "session-new", turn_id: "turn-new" });
  assert.strictEqual(newStop.json.decision, "block");
  const newCheckpointId = checkpointIdFromReason(newStop.json.reason);

  const newReceipt = runCheckpoint(repo, pluginData, ["complete", "--checkpoint-id", newCheckpointId, "--status", "clean"]);
  assert.strictEqual(newReceipt.status, 0, newReceipt.stderr);

  const oldContext = runCheckpoint(repo, pluginData, ["context"]);
  assert.strictEqual(oldContext.status, 0, oldContext.stderr);
  assert.match(oldContext.stdout, new RegExp(`checkpoint ${oldCheckpointId}`));
});

test("checkpoint id loads the requested pending checkpoint", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repo, pluginData, {
    sessionId: "session-first",
    turnId: "turn-first",
    content: "module.exports = 2;\n",
    toolUseId: "tool-first"
  });
  const firstStop = runStop(repo, pluginData, {}, { session_id: "session-first", turn_id: "turn-first" });
  assert.strictEqual(firstStop.json.decision, "block");
  const firstCheckpointId = checkpointIdFromReason(firstStop.json.reason);

  markEditedTurn(repo, pluginData, {
    sessionId: "session-second",
    turnId: "turn-second",
    content: "module.exports = 3;\n",
    toolUseId: "tool-second"
  });
  const secondStop = runStop(repo, pluginData, {}, { session_id: "session-second", turn_id: "turn-second" });
  assert.strictEqual(secondStop.json.decision, "block");

  const firstContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", firstCheckpointId]);
  assert.strictEqual(firstContext.status, 0, firstContext.stderr);
  assert.match(firstContext.stdout, new RegExp(`checkpoint ${firstCheckpointId}`));

  const secondCheckpointId = checkpointIdFromReason(secondStop.json.reason);
  const secondContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", secondCheckpointId]);
  assert.strictEqual(secondContext.status, 0, secondContext.stderr);
  assert.match(secondContext.stdout, new RegExp(`checkpoint ${secondCheckpointId}`));
  assert.doesNotMatch(secondContext.stdout, new RegExp(`checkpoint ${firstCheckpointId}`));
});

test("checkpoint id loads non-latest checkpoint in the same session", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repo, pluginData, {
    sessionId: "session-same",
    turnId: "turn-a",
    content: "module.exports = 2;\n",
    toolUseId: "tool-a"
  });
  const firstStop = runStop(repo, pluginData, {}, { session_id: "session-same", turn_id: "turn-a" });
  assert.strictEqual(firstStop.json.decision, "block");
  const firstCheckpointId = checkpointIdFromReason(firstStop.json.reason);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 1;\n", "utf8");
  markEditedTurn(repo, pluginData, {
    sessionId: "session-same",
    turnId: "turn-b",
    content: "module.exports = 3;\n",
    toolUseId: "tool-b"
  });
  const secondStop = runStop(repo, pluginData, {}, { session_id: "session-same", turn_id: "turn-b" });
  assert.strictEqual(secondStop.json.decision, "block");
  const secondCheckpointId = checkpointIdFromReason(secondStop.json.reason);
  assert.notStrictEqual(firstCheckpointId, secondCheckpointId);

  const firstContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", firstCheckpointId]);
  assert.strictEqual(firstContext.status, 0, firstContext.stderr);
  assert.match(firstContext.stdout, new RegExp(`checkpoint ${firstCheckpointId}`));

  const secondContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", secondCheckpointId]);
  assert.strictEqual(secondContext.status, 0, secondContext.stderr);
  assert.match(secondContext.stdout, new RegExp(`checkpoint ${secondCheckpointId}`));
});

test("checkpoint id rejects completed checkpoints", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repo, pluginData, {
    sessionId: "session-complete",
    turnId: "turn-complete",
    content: "module.exports = 2;\n",
    toolUseId: "tool-complete"
  });
  const stop = runStop(repo, pluginData, {}, { session_id: "session-complete", turn_id: "turn-complete" });
  assert.strictEqual(stop.json.decision, "block");
  const checkpointId = checkpointIdFromReason(stop.json.reason);

  const firstComplete = runCheckpoint(repo, pluginData, ["complete", "--checkpoint-id", checkpointId, "--status", "clean"]);
  assert.strictEqual(firstComplete.status, 0, firstComplete.stderr);

  const secondContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(secondContext.status, 1);
  assert.match(secondContext.stderr, /could not find a matching checkpoint/);
});

test("checkpoint id finds checkpoints created from a subdirectory cwd", () => {
  const repo = createRepo();
  const subdir = path.join(repo, "src");
  const pluginData = tempDir("auto-review-data-");

  const input = {
    session_id: "session-subdir",
    turn_id: "turn-subdir"
  };
  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", subdir, input), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");

  const post = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", subdir, {
      ...input,
      tool_name: "apply_patch",
      tool_use_id: "tool-subdir",
      tool_input: { command: "apply patch" },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(post.status, 0, post.stderr);

  const stop = runStop(subdir, pluginData, {}, input);
  assert.strictEqual(stop.json.decision, "block");
  const checkpointId = checkpointIdFromReason(stop.json.reason);

  const context = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(context.status, 0, context.stderr);
  assert.match(context.stdout, new RegExp(`checkpoint ${checkpointId}`));
});

test("checkpoint latest finds checkpoints created from a subdirectory cwd", () => {
  const repo = createRepo();
  const subdir = path.join(repo, "src");
  const pluginData = tempDir("auto-review-data-");

  const input = {
    session_id: "session-subdir-latest",
    turn_id: "turn-subdir-latest"
  };
  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", subdir, input), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");

  const post = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", subdir, {
      ...input,
      tool_name: "apply_patch",
      tool_use_id: "tool-subdir-latest",
      tool_input: { command: "apply patch" },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(post.status, 0, post.stderr);

  const stop = runStop(subdir, pluginData, {}, input);
  assert.strictEqual(stop.json.decision, "block");

  const context = runCheckpoint(repo, pluginData, ["context"]);
  assert.strictEqual(context.status, 0, context.stderr);
  assert.match(context.stdout, /checkpoint [a-f0-9]{16}/);
});

test("checkpoint id does not load an unrelated repository", () => {
  const repoA = createRepo();
  const repoB = createRepo();
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repoA, pluginData, {
    sessionId: "session-repo-a",
    turnId: "turn-repo-a",
    content: "module.exports = 2;\n",
    toolUseId: "tool-repo-a"
  });
  const stop = runStop(repoA, pluginData, {}, { session_id: "session-repo-a", turn_id: "turn-repo-a" });
  assert.strictEqual(stop.json.decision, "block");
  const checkpointId = checkpointIdFromReason(stop.json.reason);

  const context = runCheckpoint(repoB, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(context.status, 1);
  assert.match(context.stderr, /could not find a matching checkpoint/);
});

test("checkpoint id does not cross sibling repositories", () => {
  const workspace = tempDir("auto-review-workspace-");
  const repoA = createRepoAt(path.join(workspace, "repo-a"));
  const repoB = createRepoAt(path.join(workspace, "repo-b"));
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repoA, pluginData, {
    sessionId: "session-sibling-a",
    turnId: "turn-sibling-a",
    content: "module.exports = 2;\n",
    toolUseId: "tool-sibling-a"
  });
  const stop = runStop(repoA, pluginData, {}, { session_id: "session-sibling-a", turn_id: "turn-sibling-a" });
  assert.strictEqual(stop.json.decision, "block");
  const checkpointId = checkpointIdFromReason(stop.json.reason);

  const context = runCheckpoint(workspace, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(context.status, 1);
  assert.match(context.stderr, /could not find a matching checkpoint/);

  const siblingContext = runCheckpoint(repoB, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(siblingContext.status, 1);
  assert.match(siblingContext.stderr, /could not find a matching checkpoint/);
});

test("matching snapshot diffs still get distinct checkpoint ids per session", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  markEditedTurn(repo, pluginData, {
    sessionId: "session-a",
    turnId: "turn-a",
    content: "module.exports = 2;\n",
    toolUseId: "tool-a"
  });
  const firstStop = runStop(repo, pluginData, {}, { session_id: "session-a", turn_id: "turn-a" });
  const firstCheckpointId = checkpointIdFromReason(firstStop.json.reason);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 1;\n", "utf8");
  markEditedTurn(repo, pluginData, {
    sessionId: "session-b",
    turnId: "turn-b",
    content: "module.exports = 2;\n",
    toolUseId: "tool-b"
  });
  const secondStop = runStop(repo, pluginData, {}, { session_id: "session-b", turn_id: "turn-b" });
  const secondCheckpointId = checkpointIdFromReason(secondStop.json.reason);

  assert.notStrictEqual(firstCheckpointId, secondCheckpointId);
  const firstContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", firstCheckpointId]);
  assert.strictEqual(firstContext.status, 0, firstContext.stderr);
  assert.match(firstContext.stdout, new RegExp(`checkpoint ${firstCheckpointId}`));

  const secondContext = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", secondCheckpointId]);
  assert.strictEqual(secondContext.status, 0, secondContext.stderr);
  assert.match(secondContext.stdout, new RegExp(`checkpoint ${secondCheckpointId}`));
});

test("Stop blocks with setup instructions when the agent is unavailable", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const codexHomeFile = path.join(tempDir("auto-review-codex-home-file-"), "not-a-dir");
  fs.writeFileSync(codexHomeFile, "not a directory\n", "utf8");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { CODEX_HOME: codexHomeFile });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /could not verify the custom subagent/);
  assert.match(result.json.reason, /npx -y @just-every\/plugin-auto-review setup/);
  assert.doesNotMatch(result.json.reason, /Exact command/);
  assert.doesNotMatch(result.json.reason, /scripts\/autoreview\.js/);
  assert.doesNotMatch(result.json.reason, /scripts\/checkpoint\.js/);
});

test("checkpoint context includes tracked file deletions", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);

  fs.unlinkSync(path.join(repo, "src", "app.js"));
  const post = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      tool_name: "apply_patch",
      tool_use_id: "tool-delete",
      tool_input: { command: "delete file" },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(post.status, 0, post.stderr);

  const stop = runStop(repo, pluginData);
  assert.strictEqual(stop.json.decision, "block");
  const checkpointId = checkpointIdFromReason(stop.json.reason);
  const context = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", checkpointId]);
  assert.strictEqual(context.status, 0, context.stderr);
  assert.match(context.stdout, /Changed paths:\n- src\/app\.js/);
  assert.match(context.stdout, /deleted file mode/);
});

test("checkpoint helper does not invoke Codex review workers", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const stop = runStop(repo, pluginData);
  assert.strictEqual(stop.json.decision, "block");
  const checkpointId = checkpointIdFromReason(stop.json.reason);

  const context = runCheckpoint(repo, pluginData, ["context", "--checkpoint-id", checkpointId], {
    CODEX_CLI_PATH: "/definitely/not/codex"
  });
  assert.strictEqual(context.status, 0, context.stderr);
  assert.match(context.stdout, /You are the reviewer/);
});

test("hooks skip child sessions", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const result = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      tool_name: "apply_patch",
      tool_use_id: "tool-child",
      tool_input: {},
      tool_response: {}
    }),
    { PLUGIN_DATA: pluginData, AUTO_REVIEW_CHILD: "1" }
  );

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  assert.strictEqual(findFiles(pluginData, ".json").length, 0);
});

function runStop(repo, pluginData, env = {}, inputOverrides = {}) {
  return runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false, ...inputOverrides }), {
    PLUGIN_DATA: pluginData,
    CODEX_HOME: env.CODEX_HOME || tempDir("auto-review-codex-home-"),
    ...env
  });
}

function runCheckpoint(repo, pluginData, args = [], env = {}) {
  return childProcess.spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "checkpoint.js"),
      ...args,
      "--plugin-data",
      pluginData,
      "--cwd",
      repo
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        ...env
      },
      encoding: "utf8"
    }
  );
}

function checkpointIdFromReason(reason) {
  const match = /checkpoint ([a-f0-9]{16})/.exec(reason);
  assert.ok(match, reason);
  return match[1];
}

function createPluginCache(codexHome, version = "9.9.9") {
  const root = path.join(codexHome, "plugins", "cache", "just-every", "auto-review", version);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "checkpoint.js"), "#!/usr/bin/env node\n", "utf8");
  return root;
}

function createRepoAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.js"), "module.exports = 1;\n", "utf8");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "init"], dir);
  return dir;
}

function run(cmd, args, cwd) {
  const result = childProcess.spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function markEditedTurn(repo, pluginData, options) {
  const input = {
    session_id: options.sessionId,
    turn_id: options.turnId
  };
  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo, input), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);

  fs.writeFileSync(path.join(repo, "src", "app.js"), options.content, "utf8");

  const post = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      ...input,
      tool_name: "apply_patch",
      tool_use_id: options.toolUseId,
      tool_input: { command: "apply patch" },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(post.status, 0, post.stderr);
}

function findFiles(root, suffix) {
  const out = [];
  visit(root);
  return out;

  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) {
        visit(file);
      } else if (file.endsWith(suffix)) {
        out.push(file);
      }
    }
  }
}
