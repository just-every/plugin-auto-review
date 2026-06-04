#!/usr/bin/env node
"use strict";

const { readCheckpointForCwd, readLatestCheckpoint, updateCheckpointStatus } = require("./lib/checkpoints");
const { writeJsonAtomic } = require("./lib/state-store");

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.PLUGIN_DATA = options.pluginData;

  const checkpoint = findCheckpoint(options);
  if (!checkpoint) {
    throw new Error("Auto Code Review could not find a matching checkpoint for this repository.");
  }

  if (options.command === "context") {
    updateCheckpointStatus(checkpoint, { status: "running", startedAt: new Date().toISOString() });
    process.stdout.write(`${formatContext(checkpoint.request, commandBase(options))}\n`);
    return;
  }

  if (options.command === "complete") {
    const receipt = writeReceipt(checkpoint, options);
    process.stdout.write(`${formatReceipt(receipt)}\n`);
    return;
  }

  throw new Error("usage: checkpoint context|complete --plugin-data <path> --cwd <path> [--checkpoint-id <id>]");
}

function findCheckpoint(options) {
  if (options.checkpointId) {
    return readCheckpointForCwd({
      pluginData: options.pluginData,
      checkpointId: options.checkpointId,
      cwd: options.cwd
    });
  }
  return readLatestCheckpoint({
    pluginData: options.pluginData,
    sessionId: options.sessionId,
    cwd: options.cwd
  });
}

function writeReceipt(checkpoint, options) {
  if (!["clean", "findings", "failed"].includes(options.status)) {
    throw new Error("--status must be one of clean, findings, or failed");
  }
  const receipt = {
    status: options.status,
    checkpointId: checkpoint.request.id,
    snapshotKey: checkpoint.request.snapshotKey,
    findingCount: options.findingCount,
    summary: options.summary || null,
    reviewedAt: new Date().toISOString()
  };
  writeJsonAtomic(checkpoint.request.receiptJson, receipt);
  updateCheckpointStatus(checkpoint, {
    status: receipt.status,
    receiptJson: checkpoint.request.receiptJson,
    findingCount: receipt.findingCount,
    reviewedAt: receipt.reviewedAt
  });
  return receipt;
}

function formatContext(request, completeCommandBase) {
  const lines = [
    `Auto Code Review checkpoint ${request.id}`,
    `Repository cwd: ${request.cwd}`,
    `Repository root: ${request.repoRoot || request.cwd}`,
    `Changed paths: ${request.scope.changedPaths.length}`,
    "",
    "Review the baseline-to-final diff below. Report any correctness, regression, contract, safety, or edge-case issues directly to the parent thread.",
    "Do not edit files. Do not run another review tool. You are the reviewer.",
    "",
    "Changed paths:",
    request.scope.changedPaths.map((file) => `- ${file}`).join("\n"),
    "",
    "Diff:",
    request.scope.diff || "(empty diff)",
    "",
    "After reporting your review result to the parent thread, run exactly one receipt command:",
    `- No issues: ${completeCommandBase} --status clean`,
    `- Issues found: ${completeCommandBase} --status findings --finding-count <number>`,
    `- Could not review: ${completeCommandBase} --status failed --summary "<short reason>"`
  ];
  return lines.join("\n");
}

function formatReceipt(receipt) {
  if (receipt.status === "clean") {
    return `Recorded clean Auto Code Review receipt for checkpoint ${receipt.checkpointId}.`;
  }
  if (receipt.status === "findings") {
    const count = Number.isInteger(receipt.findingCount) ? ` with ${receipt.findingCount} issue${receipt.findingCount === 1 ? "" : "s"}` : "";
    return `Recorded Auto Code Review findings receipt${count} for checkpoint ${receipt.checkpointId}.`;
  }
  return `Recorded failed Auto Code Review receipt for checkpoint ${receipt.checkpointId}.`;
}

function commandBase(options) {
  const args = [
    shellQuote(process.execPath),
    shellQuote(__filename),
    "complete",
    "--plugin-data",
    shellQuote(options.pluginData),
    "--cwd",
    shellQuote(options.cwd)
  ];
  if (options.sessionId) args.push("--session", shellQuote(options.sessionId));
  if (options.checkpointId) args.push("--checkpoint-id", shellQuote(options.checkpointId));
  return args.join(" ");
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
    if (arg === "--checkpoint-id") {
      options.checkpointId = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--status") {
      options.status = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--finding-count") {
      options.findingCount = parseFindingCount(requireValue(args, (index += 1), arg));
      continue;
    }
    if (arg === "--summary") {
      options.summary = requireValue(args, (index += 1), arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["context", "complete"].includes(options.command)) {
    throw new Error("usage: checkpoint context|complete --plugin-data <path> --cwd <path> [--checkpoint-id <id>]");
  }
  if (!options.pluginData) throw new Error("--plugin-data is required");
  if (options.command === "complete" && !options.status) throw new Error("--status is required for checkpoint complete");
  return options;
}

function parseFindingCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("--finding-count must be a non-negative integer");
  }
  return count;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function shellQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
