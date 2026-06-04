#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const {
  REVIEW_MODEL,
  REVIEW_REASONING,
  REVIEW_SERVICE_TIER,
  runReview
} = require("./lib/codex-worker");
const { isChildSession, readHookInput } = require("./lib/hook-input");
const { writeContinue, writeStopBlock } = require("./lib/hook-output");
const { materializeSnapshot } = require("./lib/snapshot");
const { computeDiffScope } = require("./lib/diff-scope");
const { formatFindings, formatReviewFailure } = require("./lib/stop-continuation");
const { readJsonIfExists, turnPaths, writeJsonAtomic } = require("./lib/state-store");

async function main() {
  const input = readHookInput("Stop");
  if (isChildSession(input)) {
    writeContinue();
    return;
  }

  const paths = turnPaths(input);

  const baseline = readJsonIfExists(paths.baselineJson);
  if (!baseline) {
    captureCurrentAsBaseline(input, paths);
    writeContinue();
    return;
  }

  const finalSnapshot = materializeSnapshot(input.cwd, paths.finalSnapshotDir);
  if (!finalSnapshot) {
    const result = failedResult("snapshot", "working directory is no longer a git worktree");
    writeReviewFailureDiagnostic(result);
    writeContinue();
    return;
  }

  let scope;
  try {
    scope = computeDiffScope(
      paths.baselineSnapshotDir,
      paths.finalSnapshotDir,
      baseline,
      finalSnapshot
    );
  } catch (error) {
    const result = failedResult("scope", error.message);
    writeReviewFailureDiagnostic(result);
    promoteFinalToBaseline(paths, input, finalSnapshot);
    writeContinue();
    return;
  }

  if (scope.changedPaths.length === 0) {
    removeFinalSnapshot(paths);
    writeContinue();
    return;
  }

  let review;
  try {
    review = await runReview({
      snapshotDir: paths.finalSnapshotDir,
      jobDir: paths.jobDir,
      changedPaths: scope.changedPaths,
      diff: scope.diff,
      model: REVIEW_MODEL,
      reasoning: REVIEW_REASONING,
      serviceTier: REVIEW_SERVICE_TIER
    });
  } catch (error) {
    const result = failedResult("runner", error.message, { scope });
    writeReviewFailureDiagnostic(result);
    promoteFinalToBaseline(paths, input, finalSnapshot);
    writeContinue();
    return;
  }

  promoteFinalToBaseline(paths, input, finalSnapshot);

  if (review.status === "failed") {
    writeReviewFailureDiagnostic(review);
    writeContinue();
    return;
  }
  if (review.status === "findings") {
    writeStopBlock(formatFindings(review.findings));
    return;
  }
  writeContinue();
}

function failedResult(stage, error, extra = {}) {
  return {
    status: "failed",
    stage,
    error,
    failures: [
      {
        stage,
        error
      }
    ],
    ...extra
  };
}

main().catch((error) => {
  process.stderr.write(`Auto Code Review failed: ${error.message}\n`);
  writeContinue();
});

function captureCurrentAsBaseline(input, paths) {
  const baseline = materializeSnapshot(input.cwd, paths.baselineSnapshotDir);
  if (!baseline) return;
  writeBaseline(paths, input, baseline);
}

function promoteFinalToBaseline(paths, input, finalSnapshot) {
  fs.rmSync(paths.baselineSnapshotDir, { recursive: true, force: true });
  fs.cpSync(paths.finalSnapshotDir, paths.baselineSnapshotDir, { recursive: true });
  writeBaseline(paths, input, finalSnapshot);
  removeFinalSnapshot(paths);
}

function removeFinalSnapshot(paths) {
  fs.rmSync(paths.finalSnapshotDir, { recursive: true, force: true });
}

function writeBaseline(paths, input, snapshot) {
  writeJsonAtomic(paths.baselineJson, {
    ...snapshot,
    session_id: input.session_id,
    turn_id: input.turn_id,
    model: input.model,
    permission_mode: input.permission_mode
  });
}

function writeReviewFailureDiagnostic(result) {
  process.stderr.write(`${formatReviewFailure(normalizeFailureResult(result))}\n`);
}

function normalizeFailureResult(result) {
  if (Array.isArray(result.failures)) return result;
  return {
    failures: [
      {
        stage: result.stage || "review",
        error: result.error || "unknown failure"
      }
    ]
  };
}
