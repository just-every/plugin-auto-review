"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createRepo, hookInput, prepareEditedTurn, runHook, tempDir } = require("./helpers");

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
  assert.match(marked.json.hookSpecificOutput.additionalContext, /Stop review/);
  assert.strictEqual(findFiles(pluginData, ".json").filter((file) => file.includes("markers")).length, 1);
});

test("Stop skips turns without edit markers", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");

  const result = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.json, { continue: true });
});

test("Stop returns a clean system message for schema-valid clean reviews", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const result = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.continue, true);
  assert.match(result.json.systemMessage, /found no issues/);
  const resultFiles = findFiles(pluginData, "result.json");
  assert.strictEqual(resultFiles.length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(resultFiles[0], "utf8")).status, "clean");
});

test("Stop blocks when review lanes return findings", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const result = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData,
    MOCK_CODEX_FINDING: "1"
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Auto Review found 1 issue/);
  assert.match(result.json.reason, /Broken behavior/);
});

test("Stop blocks on invalid reviewer JSON instead of parsing prose", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const result = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData,
    MOCK_CODEX_INVALID_JSON: "1"
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.json.decision, "block");
  assert.match(result.json.reason, /Auto Review failed/);
  assert.match(result.json.reason, /could not read review JSON/);
});

test("Stop reports duplicate snapshot reviews from the lease", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const first = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(first.status, 0, first.stderr);

  const second = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.json.systemMessage, /already processed/);
});

test("Stop replays duplicate finding reviews as blocks", () => {
  const repo = createRepo();
  const pluginData = tempDir("auto-review-data-");
  prepareEditedTurn(repo, pluginData);

  const first = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData,
    MOCK_CODEX_FINDING: "1"
  });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(first.json.decision, "block");

  const second = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.json.decision, "block");
  assert.match(second.json.reason, /Broken behavior/);
});

test("Stop reviews tracked file deletions instead of failing snapshot capture", () => {
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

  const stop = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
    PLUGIN_DATA: pluginData
  });
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.match(stop.json.systemMessage, /found no issues/);
  const result = JSON.parse(fs.readFileSync(findFiles(pluginData, "result.json")[0], "utf8"));
  assert.deepStrictEqual(result.changedPaths, ["src/app.js"]);
});

test("Stop blocks semantically invalid reviewer output", () => {
  for (const env of [{ MOCK_CODEX_INCORRECT_EMPTY: "1" }, { MOCK_CODEX_OUT_OF_SCOPE: "1" }]) {
    const repo = createRepo();
    const pluginData = tempDir("auto-review-data-");
    prepareEditedTurn(repo, pluginData);

    const result = runHook("stop.js", hookInput("Stop", repo, { stop_hook_active: false }), {
      PLUGIN_DATA: pluginData,
      ...env
    });

    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.json.decision, "block");
    assert.match(result.json.reason, /review JSON failed schema/);
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
