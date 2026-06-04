#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { autoReviewAgentInstalled, installAutoReviewAgent } = require("./lib/agent-setup");
const { checkpointIdForSnapshot, writeCheckpoint } = require("./lib/checkpoints");
const { isChildSession, readHookInput } = require("./lib/hook-input");
const { writeContinue, writeStopBlock, writeStopMessage } = require("./lib/hook-output");
const { readEditMarkers } = require("./lib/edit-markers");
const { materializeSnapshot } = require("./lib/snapshot");
const { computeDiffScope } = require("./lib/diff-scope");
const { REVIEW_MODEL, REVIEW_REASONING, REVIEW_SERVICE_TIER } = require("./lib/codex-worker");
const { formatFindings, formatReviewFailure } = require("./lib/stop-continuation");
const { hashText, readJsonIfExists, turnPaths, writeJsonAtomic } = require("./lib/state-store");

async function main() {
  const input = readHookInput("Stop");
  if (isChildSession()) {
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
    writeJsonAtomic(paths.resultJson, failedResult("baseline", "edit markers existed but no captured baseline snapshot", markers));
    writeStopBlock("Auto Code Review could not run because this turn has edit markers but no captured baseline snapshot.");
    return;
  }

  const finalSnapshot = materializeSnapshot(input.cwd, paths.finalSnapshotDir);
  if (!finalSnapshot) {
    writeJsonAtomic(paths.resultJson, failedResult("snapshot", "working directory is no longer a git worktree", markers));
    writeStopBlock("Auto Code Review could not run because the working directory is no longer a git worktree.");
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
    writeStopBlock(`Auto Code Review could not prepare the review scope: ${error.message}`);
    return;
  }

  if (scope.changedPaths.length === 0) {
    writeJsonAtomic(paths.resultJson, {
      status: "clean",
      reason: "edit markers existed, but baseline and final snapshots matched",
      markers,
      snapshotKey: hashText(
        JSON.stringify({
          repo: finalSnapshot.repoRoot,
          base: baseline.treeHash,
          final: finalSnapshot.treeHash,
          changedPaths: scope.changedPaths
        })
      ),
      reviewedAt: new Date().toISOString()
    });
    writeStopMessage("Auto Code Review found no final code changes to review.");
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

  const existing = readJsonIfExists(paths.resultJson);
  if (existing && existing.snapshotKey === snapshotKey) {
    replayExistingResult(existing, scope.changedPaths.length);
    return;
  }

  const checkpointId = checkpointIdForSnapshot(snapshotKey);
  writeCheckpoint(input, {
    id: checkpointId,
    sessionId: input.session_id,
    turnId: input.turn_id,
    cwd: input.cwd,
    model: REVIEW_MODEL,
    reasoning: REVIEW_REASONING,
    serviceTier: REVIEW_SERVICE_TIER,
    paths,
    resultJson: paths.resultJson,
    scope,
    markers,
    snapshotKey,
    createdAt: new Date().toISOString()
  });

  writeStopBlock(buildAgentInstruction(input, paths.root, checkpointId));
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

function replayExistingResult(existing, changedPathCount) {
  if (existing.status === "failed") {
    if (Array.isArray(existing.failures)) {
      writeStopBlock(formatReviewFailure(existing));
    } else {
      writeStopBlock(
        formatReviewFailure({
          failures: [
            {
              lane: existing.stage || "review",
              error: existing.error || "unknown failure"
            }
          ]
        })
      );
    }
    return;
  }
  if (existing.status === "findings") {
    writeStopBlock(formatFindings(existing.findings || []));
    return;
  }
  writeStopMessage(`Auto Code Review checked ${changedPathCount} changed path${changedPathCount === 1 ? "" : "s"} and found no issues.`);
}

function buildAgentInstruction(input, pluginData, checkpointId) {
  const setup = ensureAgentSetup();
  const command = [
    JSON.stringify(process.execPath),
    JSON.stringify(path.join(__dirname, "autoreview.js")),
    "latest",
    "--plugin-data",
    JSON.stringify(pluginData),
    "--session",
    JSON.stringify(input.session_id),
    "--cwd",
    JSON.stringify(input.cwd)
  ].join(" ");

  const lines = [
    `Auto Code Review checkpoint ${checkpointId} is pending.`,
    "Use the visible Auto Code Review subagent before finishing.",
    "",
    setup.installed
      ? "If an Auto Code Review subagent is already open, send it the message below. Otherwise spawn agent type `auto-review` with nickname Auto Code Review."
      : setup.message,
    "",
    "Message to send to the subagent:",
    "$autoreview latest",
    "",
    "Exact command the subagent must run:",
    command,
    "",
    "After the subagent reports the review result, try finishing again."
  ];
  return lines.join("\n");
}

function ensureAgentSetup() {
  try {
    if (autoReviewAgentInstalled()) {
      return { installed: true };
    }
    const setup = installAutoReviewAgent();
    return {
      installed: false,
      message: `The Auto Code Review custom agent was installed at ${setup.path} for future sessions. If this running Codex app has not reloaded agent config yet, spawn a default gpt-5.4-mini low-reasoning subagent and tell it not to edit files.`
    };
  } catch (error) {
    return {
      installed: false,
      message: `Auto Code Review could not install the custom agent automatically: ${error.message}. Spawn a default gpt-5.4-mini low-reasoning subagent, tell it not to edit files, and give it the exact command below.`
    };
  }
}

main().catch((error) => {
  writeStopBlock(`Auto Code Review could not prepare the checkpoint review: ${error.message}`);
});
