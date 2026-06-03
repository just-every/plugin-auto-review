"use strict";

const childProcess = require("node:child_process");

const DEFAULT_MAX_DIFF_BYTES = 200_000;
const DEFAULT_MAX_CHANGED_PATHS = 100;

function manifestMap(manifest) {
  return new Map((manifest.files || []).map((file) => [file.path, file]));
}

function changedPathsBetween(baseManifest, finalManifest) {
  const base = manifestMap(baseManifest);
  const final = manifestMap(finalManifest);
  const paths = new Set([...base.keys(), ...final.keys()]);
  return [...paths]
    .filter((file) => {
      const before = base.get(file);
      const after = final.get(file);
      return !before || !after || before.hash !== after.hash || before.kind !== after.kind;
    })
    .sort();
}

function computeDiffScope(baseDir, finalDir, baseManifest, finalManifest, options = {}) {
  const maxDiffBytes = numberFromEnv("AUTO_REVIEW_MAX_DIFF_BYTES", DEFAULT_MAX_DIFF_BYTES);
  const maxChangedPaths = numberFromEnv("AUTO_REVIEW_MAX_CHANGED_PATHS", DEFAULT_MAX_CHANGED_PATHS);
  const changedPaths = changedPathsBetween(baseManifest, finalManifest);

  if (changedPaths.length === 0) {
    return { changedPaths, diff: "", diffBytes: 0 };
  }
  if (changedPaths.length > maxChangedPaths) {
    throw new Error(
      `Auto Review scope has ${changedPaths.length} changed paths, exceeding AUTO_REVIEW_MAX_CHANGED_PATHS=${maxChangedPaths}`
    );
  }

  const result = childProcess.spawnSync(
    "git",
    ["diff", "--no-index", "--no-ext-diff", "--binary", "--", baseDir, finalDir],
    {
      encoding: "utf8",
      maxBuffer: Math.max(maxDiffBytes * 2, 1024 * 1024)
    }
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git diff --no-index failed: ${(result.stderr || "").trim()}`);
  }

  const diff = result.stdout || "";
  const diffBytes = Buffer.byteLength(diff, "utf8");
  if (diffBytes > (options.maxDiffBytes || maxDiffBytes)) {
    throw new Error(
      `Auto Review diff is ${diffBytes} bytes, exceeding AUTO_REVIEW_MAX_DIFF_BYTES=${options.maxDiffBytes || maxDiffBytes}`
    );
  }

  return { changedPaths, diff, diffBytes };
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

module.exports = {
  changedPathsBetween,
  computeDiffScope
};
