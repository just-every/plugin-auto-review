"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function pluginDataRoot() {
  const root = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  if (!root || root.trim() === "") {
    throw new Error("PLUGIN_DATA is required for Auto Code Review state");
  }
  return path.resolve(root);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeSegment(value) {
  return hashText(value).slice(0, 32);
}

function turnPaths(input) {
  const root = pluginDataRoot();
  const session = safeSegment(input.session_id);
  const turn = safeSegment(input.turn_id);
  const repo = safeSegment(path.resolve(input.cwd));
  const dir = path.join(root, "turns", session, turn, repo);
  return {
    root,
    dir,
    baselineJson: path.join(dir, "baseline.json"),
    finalJson: path.join(dir, "final.json"),
    markersDir: path.join(dir, "markers"),
    resultJson: path.join(dir, "result.json"),
    baselineSnapshotDir: path.join(dir, "snapshots", "baseline"),
    finalSnapshotDir: path.join(dir, "snapshots", "final"),
    jobDir: path.join(dir, "review-job")
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

module.exports = {
  ensureDir,
  hashText,
  pluginDataRoot,
  readJsonIfExists,
  safeSegment,
  turnPaths,
  writeJsonAtomic
};
