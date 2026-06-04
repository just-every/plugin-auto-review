"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENT_FILE = "auto-review.toml";

function resolveCodexHome(options = {}) {
  return path.resolve(expandHome(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (typeof value === "string" && value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function autoReviewAgentPath(codexHome) {
  return path.join(codexHome, "agents", AGENT_FILE);
}

function autoReviewAgentInstalled(options = {}) {
  const codexHome = resolveCodexHome(options);
  const file = autoReviewAgentPath(codexHome);
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.includes('name = "auto-review"');
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function installAutoReviewAgent(options = {}) {
  const codexHome = resolveCodexHome(options);
  const file = autoReviewAgentPath(codexHome);
  const content = autoReviewAgentToml();
  let previous = null;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const changed = previous !== content;
  if (!options.dryRun && changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  return {
    codexHome,
    path: file,
    changed,
    installed: !options.dryRun && fs.existsSync(file),
    dryRun: Boolean(options.dryRun)
  };
}

function autoReviewAgentToml() {
  return `name = "auto-review"
description = "Visible Auto Code Review agent that inspects persisted review checkpoints and reports findings without editing repo files."
model = "gpt-5.4-mini"
model_reasoning_effort = "low"
sandbox_mode = "workspace-write"
nickname_candidates = ["Auto Code Review"]

developer_instructions = """
You are the Auto Code Review subagent for Codex.

Your job is to review checkpoints produced by the Auto Code Review plugin and report
the result clearly to the parent thread. Do not edit repository files, do not
apply fixes, and do not start additional agents.

When the parent asks you to run "$autoreview latest", use the autoreview skill
when it is available. If the parent includes an exact shell command, run that
command. Report the command stdout verbatim, then add a one-sentence status
summary only if the stdout is unclear.
"""
`;
}

module.exports = {
  autoReviewAgentInstalled,
  autoReviewAgentPath,
  autoReviewAgentToml,
  installAutoReviewAgent,
  resolveCodexHome
};
