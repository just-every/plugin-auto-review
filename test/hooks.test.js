"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { installAutoReviewAgent } = require("../scripts/lib/agent-setup");
const { checkpointIdForSnapshot } = require("../scripts/lib/checkpoints");
const { MOCK_CODEX, createRepo, hookInput, prepareEditedTurn, runHook, tempDir } = require("./helpers");

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
  assert.match(result.json.reason, /scripts\/autoreview\.js/);
  assert.match(result.json.reason, /--checkpoint-id [a-f0-9]{16}/);
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
  assert.match(result.json.reason, /scripts\/autoreview\.js/);
  assert.match(result.json.reason, /--checkpoint-id [a-f0-9]{16}/);
});

test("autoreview latest completes a clean checkpoint and lets Stop finish", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");

  const review = runAutoreview(repo, pluginData);
  assert.strictEqual(review.status, 0, review.stderr);
  assert.match(review.stdout, /found no issues/);
  const result = JSON.parse(fs.readFileSync(findFiles(pluginData, "result.json")[0], "utf8"));
  assert.strictEqual(result.status, "clean");

  const second = runStop(repo, pluginData);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.json.continue, true);
  assert.match(second.json.systemMessage, /found no issues/);
});

test("autoreview latest findings are enforced by the next Stop", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");

  const review = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" });
  assert.strictEqual(review.status, 0, review.stderr);
  assert.match(review.stdout, /Broken behavior/);

  const second = runStop(repo, pluginData);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.json.decision, "block");
  assert.match(second.json.reason, /Auto Code Review found 1 issue/);
  assert.match(second.json.reason, /Broken behavior/);
});

test("active Stop continuations enforce completed Auto Code Review findings", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");

  const review = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" });
  assert.strictEqual(review.status, 0, review.stderr);

  const continuation = runStop(repo, pluginData, {}, { stop_hook_active: true });
  assert.strictEqual(continuation.status, 0, continuation.stderr);
  assert.strictEqual(continuation.json.decision, "block");
  assert.match(continuation.json.reason, /Broken behavior/);
});

test("autoreview latest failures are enforced by the next Stop", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");

  const review = runAutoreview(repo, pluginData, { MOCK_CODEX_INVALID_JSON: "1" });
  assert.strictEqual(review.status, 0, review.stderr);
  assert.match(review.stdout, /Auto Code Review failed/);
  assert.match(review.stdout, /could not read review JSON/);

  const second = runStop(repo, pluginData);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.json.decision, "block");
  assert.match(second.json.reason, /Auto Code Review failed/);
  assert.match(second.json.reason, /could not read review JSON/);
});

test("Stop ignores stale clean results after the snapshot changes", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const first = runStop(repo, pluginData);
  assert.strictEqual(first.json.decision, "block");

  const clean = runAutoreview(repo, pluginData);
  assert.strictEqual(clean.status, 0, clean.stderr);
  const cleanStop = runStop(repo, pluginData);
  assert.strictEqual(cleanStop.json.continue, true);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 3;\n", "utf8");
  const changedStop = runStop(repo, pluginData);
  assert.strictEqual(changedStop.status, 0, changedStop.stderr);
  assert.strictEqual(changedStop.json.decision, "block");
  assert.match(changedStop.json.reason, /Auto Code Review checkpoint/);

  const changedReview = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" });
  assert.strictEqual(changedReview.status, 0, changedReview.stderr);
  assert.match(changedReview.stdout, /Broken behavior/);
});

test("autoreview latest ignores completed checkpoints when another session is pending", () => {
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

  markEditedTurn(repo, pluginData, {
    sessionId: "session-new",
    turnId: "turn-new",
    content: "module.exports = 3;\n",
    toolUseId: "tool-new"
  });
  const newStop = runStop(repo, pluginData, {}, { session_id: "session-new", turn_id: "turn-new" });
  assert.strictEqual(newStop.json.decision, "block");

  const newReview = runAutoreview(repo, pluginData);
  assert.strictEqual(newReview.status, 0, newReview.stderr);
  assert.match(newReview.stdout, /found no issues/);

  const oldReview = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" });
  assert.strictEqual(oldReview.status, 0, oldReview.stderr);
  assert.match(oldReview.stdout, /Broken behavior/);
});

test("autoreview checkpoint id reviews the requested pending checkpoint", () => {
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

  const firstReview = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" }, ["--checkpoint-id", firstCheckpointId]);
  assert.strictEqual(firstReview.status, 0, firstReview.stderr);
  assert.match(firstReview.stdout, /Broken behavior/);

  const secondReview = runAutoreview(repo, pluginData);
  assert.strictEqual(secondReview.status, 0, secondReview.stderr);
  assert.match(secondReview.stdout, /found no issues/);
});

test("autoreview checkpoint id reviews non-latest checkpoint in the same session", () => {
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

  const firstReview = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" }, ["--checkpoint-id", firstCheckpointId]);
  assert.strictEqual(firstReview.status, 0, firstReview.stderr);
  assert.match(firstReview.stdout, /Broken behavior/);

  const secondReview = runAutoreview(repo, pluginData, {}, ["--checkpoint-id", secondCheckpointId]);
  assert.strictEqual(secondReview.status, 0, secondReview.stderr);
  assert.match(secondReview.stdout, /found no issues/);
});

test("autoreview checkpoint id rejects completed checkpoints", () => {
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

  const firstReview = runAutoreview(repo, pluginData, {}, ["--checkpoint-id", checkpointId]);
  assert.strictEqual(firstReview.status, 0, firstReview.stderr);
  assert.match(firstReview.stdout, /found no issues/);

  const secondReview = runAutoreview(repo, pluginData, {}, ["--checkpoint-id", checkpointId]);
  assert.strictEqual(secondReview.status, 1);
  assert.match(secondReview.stderr, /could not find a matching checkpoint/);
});

test("autoreview checkpoint id finds checkpoints created from a subdirectory cwd", () => {
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

  const review = runAutoreview(repo, pluginData, {}, ["--checkpoint-id", checkpointId]);
  assert.strictEqual(review.status, 0, review.stderr);
  assert.match(review.stdout, /found no issues/);
});

test("autoreview latest finds checkpoints created from a subdirectory cwd", () => {
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

  const review = runAutoreview(repo, pluginData);
  assert.strictEqual(review.status, 0, review.stderr);
  assert.match(review.stdout, /found no issues/);
});

test("autoreview checkpoint id does not review an unrelated repository", () => {
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

  const review = runAutoreview(repoB, pluginData, {}, ["--checkpoint-id", checkpointId]);
  assert.strictEqual(review.status, 1);
  assert.match(review.stderr, /could not find a matching checkpoint/);
});

test("autoreview checkpoint id does not cross sibling repositories", () => {
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

  const review = runAutoreview(workspace, pluginData, {}, ["--checkpoint-id", checkpointId]);
  assert.strictEqual(review.status, 1);
  assert.match(review.stderr, /could not find a matching checkpoint/);

  const siblingReview = runAutoreview(repoB, pluginData, {}, ["--checkpoint-id", checkpointId]);
  assert.strictEqual(siblingReview.status, 1);
  assert.match(siblingReview.stderr, /could not find a matching checkpoint/);
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
  const firstReview = runAutoreview(repo, pluginData, { MOCK_CODEX_FINDING: "1" }, ["--checkpoint-id", firstCheckpointId]);
  assert.strictEqual(firstReview.status, 0, firstReview.stderr);
  assert.match(firstReview.stdout, /Broken behavior/);

  const secondReview = runAutoreview(repo, pluginData, {}, ["--checkpoint-id", secondCheckpointId]);
  assert.strictEqual(secondReview.status, 0, secondReview.stderr);
  assert.match(secondReview.stdout, /found no issues/);
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
});

test("autoreview latest reviews tracked file deletions", () => {
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
  const review = runAutoreview(repo, pluginData);
  assert.strictEqual(review.status, 0, review.stderr);
  const result = JSON.parse(fs.readFileSync(findFiles(pluginData, "result.json")[0], "utf8"));
  assert.deepStrictEqual(result.changedPaths, ["src/app.js"]);
});

test("autoreview latest starts review workers with bounded codex resource args", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  const stdinLog = path.join(pluginData, "codex-stdin.jsonl");
  prepareEditedTurn(repo, pluginData);
  const stop = runStop(repo, pluginData);
  assert.strictEqual(stop.json.decision, "block");

  const review = runAutoreview(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog, MOCK_CODEX_STDIN_LOG: stdinLog });
  assert.strictEqual(review.status, 0, review.stderr);
  const lines = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const args = JSON.parse(line);
    assertArgSequence(args, ["-m", "gpt-5.5"]);
    assertArgSequence(args, ["-c", 'model_reasoning_effort="medium"']);
    assertArgSequence(args, ["-c", 'service_tier="default"']);
    assertArgSequence(args, ["--sandbox", "read-only"]);
    assert.ok(args.includes("--ephemeral"));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("--ignore-rules"));
    assert.ok(args.includes("--skip-git-repo-check"));
  }
  const prompts = fs.readFileSync(stdinLog, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.ok(!prompt.startsWith("/review"), prompt);
  }
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

function runAutoreview(repo, pluginData, env = {}, extraArgs = []) {
  fs.chmodSync(MOCK_CODEX, 0o755);
  return childProcess.spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "autoreview.js"),
      "latest",
      "--plugin-data",
      pluginData,
      "--cwd",
      repo,
      ...extraArgs
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        CODEX_CLI_PATH: MOCK_CODEX,
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
  fs.writeFileSync(path.join(root, "scripts", "autoreview.js"), "#!/usr/bin/env node\n", "utf8");
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

function assertArgSequence(args, sequence) {
  for (let index = 0; index <= args.length - sequence.length; index += 1) {
    if (sequence.every((item, offset) => args[index + offset] === item)) return;
  }
  assert.fail(`expected args to include sequence ${JSON.stringify(sequence)} in ${JSON.stringify(args)}`);
}
