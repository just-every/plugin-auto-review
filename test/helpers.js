"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MOCK_CODEX = path.join(ROOT, "test", "fixtures", "mock-codex.js");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function run(cmd, args, cwd) {
  const result = childProcess.spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function createRepo() {
  const dir = tempDir("auto-review-repo-");
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "app.js"), "module.exports = 1;\n", "utf8");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "init"], dir);
  return dir;
}

function hookInput(event, cwd, overrides = {}) {
  return {
    session_id: "session-1",
    turn_id: "turn-1",
    transcript_path: null,
    cwd,
    hook_event_name: event,
    model: "gpt-5.5",
    permission_mode: "default",
    ...overrides
  };
}

function runHook(script, input, env = {}) {
  fs.chmodSync(MOCK_CODEX, 0o755);
  const result = childProcess.spawnSync(process.execPath, [path.join(ROOT, "scripts", script)], {
    input: JSON.stringify(input),
    env: {
      ...process.env,
      PLUGIN_DATA: env.PLUGIN_DATA || tempDir("auto-review-data-"),
      CODEX_CLI_PATH: MOCK_CODEX,
      ...env
    },
    encoding: "utf8"
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null
  };
}

function prepareEditedTurn(repo, pluginData, env = {}) {
  const user = runHook("user-prompt-submit.js", hookInput("UserPromptSubmit", repo), {
    PLUGIN_DATA: pluginData,
    ...env
  });
  if (user.status !== 0) throw new Error(user.stderr);

  fs.writeFileSync(path.join(repo, "src", "app.js"), "module.exports = 2;\n", "utf8");

  const post = runHook(
    "post-tool-use.js",
    hookInput("PostToolUse", repo, {
      tool_name: "apply_patch",
      tool_use_id: "tool-1",
      tool_input: { command: "apply patch" },
      tool_response: { output: "Success" }
    }),
    { PLUGIN_DATA: pluginData, ...env }
  );
  if (post.status !== 0) throw new Error(post.stderr);
  return { user, post };
}

module.exports = {
  MOCK_CODEX,
  createRepo,
  hookInput,
  prepareEditedTurn,
  runHook,
  tempDir
};
