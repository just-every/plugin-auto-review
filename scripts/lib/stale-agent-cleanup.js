"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveCodexHome } = require("./codex-home");

function removeStaleAutoReviewAgent(options = {}) {
  const codexHome = resolveCodexHome({ codexHome: options.codexHome });
  const file = path.join(codexHome, "agents", "auto-review.toml");
  const content = readFileIfExists(file);
  if (content === null) {
    return { path: file, status: "absent" };
  }
  if (!isStaleAutoReviewAgent(content)) {
    return { path: file, status: "skipped-unrecognized" };
  }
  if (!options.dryRun) {
    fs.rmSync(file, { force: true });
  }
  return { path: file, status: options.dryRun ? "would-remove" : "removed" };
}

function readFileIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isStaleAutoReviewAgent(content) {
  return (
    content.includes('name = "auto-review"') &&
    content.includes("Auto Code Review")
  );
}

module.exports = {
  isStaleAutoReviewAgent,
  removeStaleAutoReviewAgent
};
