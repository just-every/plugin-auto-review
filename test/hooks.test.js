"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { MOCK_CODEX, createRepo, hookInput, prepareEditedTurn, runHook, tempDir } = require("./helpers");

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

test("UserPromptSubmit reports configuration failures without blocking the parent turn", () => {
  const repo = createRepo();

  const result = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: ""
  });

  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, { continue: true });
  assert.match(result.stderr, /PLUGIN_DATA is required/);
});

test("Stop captures a baseline when none exists", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const result = runStop(repo, pluginData);

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  const baseline = readOnlyFile(pluginData, "baseline.json");
  assert.ok(baseline.files.some((file) => file.path === "src/app.js"));
});

test("Stop captures changed current state as baseline when no earlier baseline exists", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");

  const result = runStop(repo, pluginData);

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
  const snapshotFiles = findFiles(pluginData, path.join("snapshots", "baseline", "src", "app.js"));
  assert.strictEqual(snapshotFiles.length, 1);
  assert.strictEqual(fs.readFileSync(snapshotFiles[0], "utf8"), "module.exports = 2;\n");
});

test("Stop runs a clean synchronous review, advances the baseline, and finishes silently", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  const firstRuns = countLines(argvLog);
  assert.ok(firstRuns > 0);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
  assert.strictEqual(readSnapshotFile(pluginData, path.join("baseline", "src", "app.js")), "module.exports = 2;\n");
  assert.strictEqual(findFiles(pluginData, path.join("snapshots", "final", "src", "app.js")).length, 0);

  const later = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(later.json, { continue: true });
  assert.strictEqual(countLines(argvLog), firstRuns);
});

test("Stop reviews changed snapshots from the captured baseline", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);
  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");

  const result = runStop(repo, pluginData);

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  assert.strictEqual(readSnapshotFile(pluginData, path.join("baseline", "src", "app.js")), "module.exports = 2;\n");
  assert.strictEqual(findFiles(pluginData, path.join("snapshots", "final", "src", "app.js")).length, 0);
});

test("Stop excludes dirty files that existed before the turn baseline", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const stdinLog = path.join(pluginData, "codex-stdin.jsonl");
  fs.writeFileSync(path.join(repo, "pre-existing.txt"), "already dirty\n", "utf8");

  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);
  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");

  const result = runStop(repo, pluginData, { MOCK_CODEX_STDIN_LOG: stdinLog });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  const prompts = findReviewPrompts(pluginData);
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.match(prompt, /Changed paths:\n- src\/app\.js/);
    assert.doesNotMatch(prompt, /Changed paths:\n- pre-existing\.txt/);
  }
});

test("Stop blocks once with synchronous review findings and advances the baseline", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { MOCK_CODEX_FINDING: "1", MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Auto Code Review found 1 issue/);
  assert.match(result.json.reason, /Broken behavior/);
  const firstRuns = countLines(argvLog);
  assert.ok(firstRuns > 0);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
  assert.strictEqual(readSnapshotFile(pluginData, path.join("baseline", "src", "app.js")), "module.exports = 2;\n");
  assert.strictEqual(findFiles(pluginData, path.join("snapshots", "final", "src", "app.js")).length, 0);

  const later = runStop(repo, pluginData, { MOCK_CODEX_FINDING: "1", MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(later.json, { continue: true });
  assert.strictEqual(countLines(argvLog), firstRuns);
});

test("active Stop continuations do not replay existing findings for unchanged code", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const first = runStop(repo, pluginData, { MOCK_CODEX_FINDING: "1", MOCK_CODEX_ARGV_LOG: argvLog });
  assert.strictEqual(first.json.decision, "block");
  const firstRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;
  assert.ok(firstRuns > 0);

  const continuation = runStop(repo, pluginData, {
    MOCK_CODEX_FINDING: "1",
    MOCK_CODEX_ARGV_LOG: argvLog
  }, { stop_hook_active: true });

  assert.strictEqual(continuation.status, 0, continuation.stderr);
  assert.deepStrictEqual(continuation.json, { continue: true });
  assert.strictEqual(countLines(argvLog), firstRuns);
});

test("active Stop continuations reuse existing clean reviews", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const first = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });
  assert.deepStrictEqual(first.json, { continue: true });
  const firstRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;
  assert.ok(firstRuns > 0);

  const continuation = runStop(repo, pluginData, {
    MOCK_CODEX_ARGV_LOG: argvLog
  }, { stop_hook_active: true });

  assert.strictEqual(continuation.status, 0, continuation.stderr);
  assert.deepStrictEqual(continuation.json, { continue: true });
  const totalRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;
  assert.strictEqual(totalRuns, firstRuns);
});

test("Stop allows review worker failures with a controlled diagnostic", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, { MOCK_CODEX_INVALID_JSON: "1" });

  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, { continue: true });
  assert.match(result.stderr, /Auto Code Review failed/);
  assert.match(result.stderr, /could not read review JSON/);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
  assert.strictEqual(readSnapshotFile(pluginData, path.join("baseline", "src", "app.js")), "module.exports = 2;\n");
  assert.strictEqual(findFiles(pluginData, path.join("snapshots", "final", "src", "app.js")).length, 0);
});

test("Stop does not rerun review worker failures for unchanged code", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const failed = runStop(repo, pluginData, {
    MOCK_CODEX_INVALID_JSON: "1",
    MOCK_CODEX_ARGV_LOG: argvLog
  });
  assert.deepStrictEqual(failed.json, { continue: true });
  assert.match(failed.stderr, /could not read review JSON/);
  const failedRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;
  assert.ok(failedRuns > 0);

  const later = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(later.json, { continue: true });
  const totalRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;
  assert.strictEqual(totalRuns, failedRuns);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
});

test("Stop advances the baseline after runner failures", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const failed = runStop(repo, pluginData, {
    AUTO_REVIEW_TIMEOUT_MS: "not-a-number",
    MOCK_CODEX_ARGV_LOG: argvLog
  });

  assert.strictEqual(failed.status, 0);
  assert.deepStrictEqual(failed.json, { continue: true });
  assert.match(failed.stderr, /AUTO_REVIEW_TIMEOUT_MS/);
  assert.strictEqual(fs.existsSync(argvLog), false);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);

  const replayed = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(replayed.status, 0, replayed.stderr);
  assert.deepStrictEqual(replayed.json, { continue: true });
  assert.strictEqual(fs.existsSync(argvLog), false);
});

test("Stop reviews again after a failed review when the snapshot changes", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const failed = runStop(repo, pluginData, {
    MOCK_CODEX_INVALID_JSON: "1",
    MOCK_CODEX_ARGV_LOG: argvLog
  });
  assert.deepStrictEqual(failed.json, { continue: true });
  assert.match(failed.stderr, /could not read review JSON/);
  const failedRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 3;\n", "utf8");
  const changed = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(changed.status, 0, changed.stderr);
  assert.deepStrictEqual(changed.json, { continue: true });
  const totalRuns = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).length;
  assert.strictEqual(totalRuns, failedRuns * 2);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
});

test("Stop allows hung review worker timeouts with a controlled diagnostic", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, {
    AUTO_REVIEW_TIMEOUT_MS: "25",
    MOCK_CODEX_HANG: "1"
  });

  assert.strictEqual(result.status, 0);
  assert.deepStrictEqual(result.json, { continue: true });
  assert.match(result.stderr, /timed out after 25ms/);
  assert.strictEqual(findFiles(pluginData, "result.json").length, 0);
});

test("Stop reviews new changes after a clean review advances the baseline", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  prepareEditedTurn(repo, pluginData);

  const clean = runStop(repo, pluginData, { MOCK_CODEX_ARGV_LOG: argvLog });
  assert.deepStrictEqual(clean.json, { continue: true });
  const firstRuns = countLines(argvLog);
  assert.ok(firstRuns > 0);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 3;\n", "utf8");
  const changed = runStop(repo, pluginData, { MOCK_CODEX_FINDING: "1", MOCK_CODEX_ARGV_LOG: argvLog });

  assert.strictEqual(changed.status, 0, changed.stderr);
  assert.strictEqual(changed.json.decision, "block");
  assert.match(changed.json.reason, /Broken behavior/);
  assert.strictEqual(countLines(argvLog), firstRuns * 2);
});

test("Stop reviews tracked file deletions", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const stdinLog = path.join(pluginData, "codex-stdin.jsonl");
  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(user.status, 0, user.stderr);

  fs.unlinkSync(path.join(repo, "src", "app.js"));

  const result = runStop(repo, pluginData, { MOCK_CODEX_STDIN_LOG: stdinLog });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
  const prompts = findReviewPrompts(pluginData);
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.match(prompt, /Changed paths:\n- src\/app\.js/);
  }
});

test("Stop starts one review worker with bounded codex resource args", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  const envLog = path.join(pluginData, "codex-env.jsonl");
  const stdinLog = path.join(pluginData, "codex-stdin.jsonl");
  prepareEditedTurn(repo, pluginData);

  const result = runStop(repo, pluginData, {
    MOCK_CODEX_ARGV_LOG: argvLog,
    MOCK_CODEX_ENV_LOG: envLog,
    MOCK_CODEX_STDIN_LOG: stdinLog
  });

  assert.strictEqual(result.status, 0, result.stderr);
  const argsByRun = fs.readFileSync(argvLog, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(argsByRun.length, 1);
  for (const args of argsByRun) {
    const workerDir = argValue(args, "--cd");
    const schemaPath = argValue(args, "--output-schema");
    const lastMessagePath = argValue(args, "--output-last-message");
    assertArgSequence(args, ["-m", "gpt-5.5"]);
    assertArgSequence(args, ["-c", 'model_reasoning_effort="medium"']);
    assertArgSequence(args, ["-c", 'service_tier="default"']);
    assertArgSequence(args, ["--sandbox", "workspace-write"]);
    assert.ok(args.includes("--ephemeral"));
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(args.includes("--ignore-rules"));
    assert.ok(args.includes("--skip-git-repo-check"));
    assert.ok(workerDir.endsWith(`${path.sep}review-job${path.sep}reviewer`));
    assert.ok(isInsidePath(schemaPath, workerDir));
    assert.ok(isInsidePath(lastMessagePath, workerDir));
    assert.ok(!workerDir.includes(`${path.sep}snapshots${path.sep}final`));
    assert.ok(!schemaPath.includes(`${path.sep}snapshots${path.sep}final`));
    assert.ok(!lastMessagePath.includes(`${path.sep}snapshots${path.sep}final`));
    assert.ok(fs.existsSync(schemaPath));
    assert.ok(fs.existsSync(lastMessagePath));
  }
  const prompts = fs.readFileSync(stdinLog, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.ok(!prompt.startsWith("/review"), prompt);
    assert.match(prompt, /Repository snapshot root: /);
    assert.match(prompt, /current working directory is review infrastructure/);
  }
  const envs = fs.readFileSync(envLog, "utf8").trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(envs.length, argsByRun.length);
  for (const [index, env] of envs.entries()) {
    assert.strictEqual(env.AUTO_REVIEW_CHILD, "1");
    assert.strictEqual(env.AUTO_REVIEW_CHILD_CWD, argValue(argsByRun[index], "--cd"));
    assert.ok(env.AUTO_REVIEW_SNAPSHOT_DIR.includes(`${path.sep}snapshots${path.sep}final`));
    assert.ok(!isInsidePath(argValue(argsByRun[index], "--cd"), env.AUTO_REVIEW_SNAPSHOT_DIR));
  }
});

test("hooks skip only scoped Auto Review child sessions", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);
  const argvLog = path.join(pluginData, "codex-argv.jsonl");
  const bareStop = runStop(repo, pluginData, {
    AUTO_REVIEW_CHILD: "1",
    MOCK_CODEX_ARGV_LOG: argvLog
  });

  assert.strictEqual(bareStop.status, 0, bareStop.stderr);
  assert.deepStrictEqual(bareStop.json, { continue: true });
  assert.ok(fs.existsSync(argvLog));

  const scopedStopData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, scopedStopData);
  const scopedArgvLog = path.join(scopedStopData, "codex-argv.jsonl");
  const scopedStop = runStop(repo, scopedStopData, {
    AUTO_REVIEW_CHILD: "1",
    AUTO_REVIEW_CHILD_CWD: repo,
    MOCK_CODEX_ARGV_LOG: scopedArgvLog
  });

  assert.strictEqual(scopedStop.status, 0, scopedStop.stderr);
  assert.deepStrictEqual(scopedStop.json, { continue: true });
  assert.strictEqual(fs.existsSync(scopedArgvLog), false);
});

function runStop(repo, pluginData, env = {}, inputOverrides = {}) {
  fs.chmodSync(MOCK_CODEX, 0o755);
  return runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false, ...inputOverrides }), {
    PLUGIN_DATA: pluginData,
    CODEX_CLI_PATH: MOCK_CODEX,
    ...env
  });
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

function readOnlyFile(root, suffix) {
  const files = findFiles(root, suffix);
  assert.strictEqual(files.length, 1, `expected one ${suffix}, found ${files.length}`);
  return JSON.parse(fs.readFileSync(files[0], "utf8"));
}

function readSnapshotFile(root, suffix) {
  const files = findFiles(root, path.join("snapshots", suffix));
  assert.strictEqual(files.length, 1, `expected one snapshot file ${suffix}, found ${files.length}`);
  return fs.readFileSync(files[0], "utf8");
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean).length;
}

function findReviewPrompts(root) {
  return findFiles(root, "codex-stdin.jsonl")
    .flatMap((file) => fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean))
    .map((line) => JSON.parse(line));
}

function assertArgSequence(args, sequence) {
  for (let index = 0; index <= args.length - sequence.length; index += 1) {
    if (sequence.every((item, offset) => args[index + offset] === item)) return;
  }
  assert.fail(`expected args to include sequence ${JSON.stringify(sequence)} in ${JSON.stringify(args)}`);
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notStrictEqual(index, -1, `missing ${flag} in ${JSON.stringify(args)}`);
  assert.ok(args[index + 1], `missing ${flag} value in ${JSON.stringify(args)}`);
  return args[index + 1];
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
