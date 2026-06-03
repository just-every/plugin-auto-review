#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const { isChildSession, readHookInput } = require("./lib/hook-input");
const { writeContinue, writeStopBlock, writeStopMessage } = require("./lib/hook-output");
const { readEditMarkers } = require("./lib/edit-markers");
const { acquireLease } = require("./lib/leases");
const { materializeSnapshot } = require("./lib/snapshot");
const { computeDiffScope } = require("./lib/diff-scope");
const { runReviewLanes } = require("./lib/codex-worker");
const { mergeReviewResults } = require("./lib/result-merge");
const { formatFindings, formatReviewFailure } = require("./lib/stop-continuation");
const { hashText, readJsonIfExists, turnPaths, writeJsonAtomic } = require("./lib/state-store");

async function main() {
  const input = readHookInput("Stop");
  if (isChildSession() || input.stop_hook_active === true) {
    writeContinue();
    return;
  }

  const paths = turnPaths(input);
  const markers = readEditMarkers(paths);
  if (markers.length === 0) {
    writeContinue();
    return;
  }

  const baseline = readJsonIfExists(paths.baselineJson);
  if (!baseline) {
    writeStopBlock("Auto Review could not run because this turn has edit markers but no captured baseline snapshot.");
    return;
  }

  const finalSnapshot = materializeSnapshot(input.cwd, paths.finalSnapshotDir);
  if (!finalSnapshot) {
    writeStopBlock("Auto Review could not run because the working directory is no longer a git worktree.");
    return;
  }
  writeJsonAtomic(paths.finalJson, finalSnapshot);

  let scope;
  try {
    scope = computeDiffScope(
      paths.baselineSnapshotDir,
      paths.finalSnapshotDir,
      baseline,
      finalSnapshot
    );
  } catch (error) {
    writeJsonAtomic(paths.resultJson, failedResult("scope", error.message, markers));
    writeStopBlock(`Auto Review could not prepare the review scope: ${error.message}`);
    return;
  }

  if (scope.changedPaths.length === 0) {
    writeJsonAtomic(paths.resultJson, {
      status: "clean",
      reason: "edit markers existed, but baseline and final snapshots matched",
      markers,
      reviewedAt: new Date().toISOString()
    });
    writeStopMessage("Auto Review found no final code changes to review.");
    return;
  }

  const snapshotKey = hashText(
    JSON.stringify({
      repo: finalSnapshot.repoRoot,
      base: baseline.treeHash,
      final: finalSnapshot.treeHash,
      changedPaths: scope.changedPaths
    })
  );
  const lease = acquireLease(paths, snapshotKey);
  if (!lease.acquired) {
    const existing = readJsonIfExists(paths.resultJson);
    if (existing) {
      replayExistingResult(existing);
    } else {
      writeStopBlock("Auto Review is already running for this snapshot. Wait for that review before finishing.");
    }
    return;
  }

  fs.rmSync(paths.jobDir, { recursive: true, force: true });
  let laneResults;
  try {
    laneResults = await runReviewLanes({
      snapshotDir: paths.finalSnapshotDir,
      jobDir: paths.jobDir,
      changedPaths: scope.changedPaths,
      diff: scope.diff,
      model: process.env.AUTO_REVIEW_MODEL || input.model
    });
  } catch (error) {
    const result = failedResult("runner", error.message, markers);
    writeJsonAtomic(paths.resultJson, result);
    writeStopBlock(formatReviewFailure({ failures: [{ lane: "runner", error: error.message }] }));
    return;
  }

  const merged = mergeReviewResults(laneResults);
  const result = {
    ...merged,
    markers,
    changedPaths: scope.changedPaths,
    diffBytes: scope.diffBytes,
    snapshotKey,
    reviewedAt: new Date().toISOString()
  };
  writeJsonAtomic(paths.resultJson, result);

  if (merged.status === "failed") {
    writeStopBlock(formatReviewFailure(merged));
    return;
  }
  if (merged.status === "findings") {
    writeStopBlock(formatFindings(merged.findings));
    return;
  }
  writeStopMessage(`Auto Review checked ${scope.changedPaths.length} changed path${scope.changedPaths.length === 1 ? "" : "s"} and found no issues.`);
}

function failedResult(stage, error, markers) {
  return {
    status: "failed",
    stage,
    error,
    markers,
    reviewedAt: new Date().toISOString()
  };
}

function replayExistingResult(existing) {
  if (existing.status === "failed") {
    if (existing.failures) {
      writeStopBlock(formatReviewFailure(existing));
    } else {
      writeStopBlock(`Auto Review failed before it could sign off on this turn.\n- ${existing.stage || "review"}: ${existing.error || "unknown failure"}`);
    }
    return;
  }
  if (existing.status === "findings") {
    writeStopBlock(formatFindings(existing.findings || []));
    return;
  }
  writeStopMessage(`Auto Review already processed this snapshot with status: ${existing.status}.`);
}

main().catch((error) => {
  writeStopBlock(`Auto Review failed: ${error.message}`);
});
