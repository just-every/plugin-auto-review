"use strict";

const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
      tool_input: {},
      tool_response: {}
    }),
    { PLUGIN_DATA: pluginData }
  );
  assert.strictEqual(marked.status, 0, marked.stderr);
  assert.match(marked.json.hookSpecificOutput.additionalContext, /Stop checkpoint review/);
  assert.strictEqual(findFiles(pluginData, ".json").filter((file) => file.includes("markers")).length, 1);
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

test("Stop writes checkpoint and blocks with Auto Code Review agent instructions", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const codexHome = tempDir("auto-review-codex-home-");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { CODEX_HOME: codexHome });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Auto Code Review checkpoint/);
  assert.match(result.json.reason, /agent type `auto-review`|default gpt-5\.4-mini/);
  assert.match(result.json.reason, /\$autoreview latest/);
  assert.match(result.json.reason, /scripts\/autoreview\.js/);
  assert.strictEqual(findFiles(pluginData, "request.json").length, 1);
  assert.ok(fs.existsSync(path.join(codexHome, "agents", "auto-review.toml")));
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

test("Stop blocks with fallback instructions when agent setup fails", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const codexHomeFile = path.join(tempDir("auto-review-codex-home-file-"), "not-a-dir");
  fs.writeFileSync(codexHomeFile, "not a directory\n", "utf8");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { CODEX_HOME: codexHomeFile });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /could not install the custom agent automatically/);
  assert.match(result.json.reason, /Exact command the subagent must run/);
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

function runAutoreview(repo, pluginData, env = {}) {
  fs.chmodSync(MOCK_CODEX, 0o755);
  return childProcess.spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "autoreview.js"),
      "latest",
      "--plugin-data",
      pluginData,
      "--session",
      "session-1",
      "--cwd",
      repo
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
