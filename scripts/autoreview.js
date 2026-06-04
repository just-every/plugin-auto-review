#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const { readLatestCheckpoint, updateCheckpointStatus } = require("./lib/checkpoints");
const { runReviewLanes } = require("./lib/codex-worker");
const { mergeReviewResults } = require("./lib/result-merge");
const { formatFindings, formatReviewFailure } = require("./lib/stop-continuation");
const { writeJsonAtomic } = require("./lib/state-store");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== "latest") {
    throw new Error("usage: autoreview latest --plugin-data <path> --session <id> --cwd <path>");
  }
  process.env.PLUGIN_DATA = options.pluginData;

  const checkpoint = readLatestCheckpoint({
    pluginData: options.pluginData,
    sessionId: options.sessionId,
    cwd: options.cwd
  });
  if (!checkpoint) {
    throw new Error("Auto Code Review could not find a latest checkpoint for this session and cwd.");
  }

  const existing = readResult(checkpoint.request.resultJson);
  if (existing && existing.snapshotKey === checkpoint.request.snapshotKey) {
    updateCheckpointStatus(checkpoint, { status: existing.status, resultJson: checkpoint.request.resultJson });
    process.stdout.write(`${formatResult(existing, checkpoint.request)}\n`);
    return;
  }

  updateCheckpointStatus(checkpoint, { status: "running", startedAt: new Date().toISOString() });
  const result = await runCheckpointReview(checkpoint.request);
  writeJsonAtomic(checkpoint.request.resultJson, result);
  updateCheckpointStatus(checkpoint, {
    status: result.status,
    resultJson: checkpoint.request.resultJson,
    reviewedAt: result.reviewedAt
  });
  process.stdout.write(`${formatResult(result, checkpoint.request)}\n`);
}

async function runCheckpointReview(request) {
  let result;
  try {
    const laneResults = await runReviewLanes({
      snapshotDir: request.paths.finalSnapshotDir,
      jobDir: request.paths.jobDir,
      changedPaths: request.scope.changedPaths,
      diff: request.scope.diff,
      model: request.model,
      reasoning: request.reasoning,
      serviceTier: request.serviceTier
    });
    result = {
      ...mergeReviewResults(laneResults),
      markers: request.markers,
      changedPaths: request.scope.changedPaths,
      diffBytes: request.scope.diffBytes,
      snapshotKey: request.snapshotKey,
      reviewedAt: new Date().toISOString()
    };
  } catch (error) {
    result = {
      status: "failed",
      stage: "runner",
      error: error.message,
      markers: request.markers,
      changedPaths: request.scope.changedPaths,
      snapshotKey: request.snapshotKey,
      reviewedAt: new Date().toISOString()
    };
  }
  return result;
}

function formatResult(result, request) {
  if (result.status === "findings") {
    return formatFindings(result.findings || []);
  }
  if (result.status === "failed") {
    if (Array.isArray(result.failures)) return formatReviewFailure(result);
    return formatReviewFailure({
      failures: [
        {
          lane: result.stage || "review",
          error: result.error || "unknown failure"
        }
      ]
    });
  }
  return `Auto Code Review checked ${request.scope.changedPaths.length} changed path${request.scope.changedPaths.length === 1 ? "" : "s"} and found no issues.`;
}

function readResult(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseArgs(args) {
  const options = {
    command: args[0],
    cwd: process.cwd()
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plugin-data") {
      options.pluginData = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--session") {
      options.sessionId = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = requireValue(args, (index += 1), arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.pluginData) throw new Error("--plugin-data is required");
  if (!options.sessionId) throw new Error("--session is required");
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
