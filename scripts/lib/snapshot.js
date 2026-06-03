"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { gitHead, gitStatus, listSnapshotFiles, maybeGitWorktree } = require("./git");
const { ensureDir, hashText } = require("./state-store");

function assertSafeRelativePath(relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`git path must be relative: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`unsafe git path: ${relativePath}`);
  }
  return normalized;
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function copyPath(source, destination) {
  const stat = fs.lstatSync(source);
  ensureDir(path.dirname(destination));
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`snapshot only supports files and symlinks: ${source}`);
  }
  fs.copyFileSync(source, destination);
}

function materializeSnapshot(cwd, destination) {
  const repoRoot = maybeGitWorktree(cwd);
  if (!repoRoot) {
    return null;
  }

  fs.rmSync(destination, { recursive: true, force: true });
  ensureDir(destination);

  const files = listSnapshotFiles(repoRoot);
  const manifestFiles = [];
  const missingFiles = [];
  for (const file of files) {
    const relative = assertSafeRelativePath(file);
    const source = path.join(repoRoot, relative);
    if (!fs.existsSync(source)) {
      missingFiles.push(relative);
      continue;
    }
    const target = path.join(destination, relative);
    copyPath(source, target);
    const stat = fs.lstatSync(source);
    manifestFiles.push({
      path: relative,
      kind: stat.isSymbolicLink() ? "symlink" : "file",
      hash: stat.isSymbolicLink() ? hashText(fs.readlinkSync(source)) : hashFile(source)
    });
  }

  return {
    repoRoot,
    cwd: path.resolve(cwd),
    head: gitHead(repoRoot),
    status: gitStatus(repoRoot),
    capturedAt: new Date().toISOString(),
    files: manifestFiles,
    missingFiles,
    treeHash: hashText(JSON.stringify(manifestFiles))
  };
}

module.exports = {
  materializeSnapshot
};
