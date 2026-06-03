"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

function runGit(cwd, args, options = {}) {
  const result = childProcess.spawnSync("git", args, {
    cwd,
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer || 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout;
}

function maybeGitWorktree(cwd) {
  const result = childProcess.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8"
  });
  if (result.status !== 0) return null;
  return path.resolve(result.stdout.trim());
}

function gitHead(cwd) {
  const result = childProcess.spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitStatus(cwd) {
  return runGit(cwd, ["status", "--porcelain=v1", "-z"], { encoding: "buffer" }).toString("utf8");
}

function listSnapshotFiles(cwd) {
  const stdout = runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

module.exports = {
  gitHead,
  gitStatus,
  listSnapshotFiles,
  maybeGitWorktree,
  runGit
};
