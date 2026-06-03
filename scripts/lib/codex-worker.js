"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { REVIEW_SCHEMA, validateReviewResult } = require("./review-schema");
const { REVIEW_LANES, buildReviewPrompt } = require("./review-prompt");
const { ensureDir, writeJsonAtomic } = require("./state-store");

function codexBin() {
  const bin = process.env.AUTO_REVIEW_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex";
  if (!bin.trim()) {
    throw new Error("AUTO_REVIEW_CODEX_BIN or CODEX_CLI_PATH must not be empty");
  }
  return bin;
}

async function runReviewLanes({ snapshotDir, jobDir, changedPaths, diff, model }) {
  ensureDir(jobDir);
  const schemaPath = path.join(snapshotDir, ".auto-review.schema.json");
  writeJsonAtomic(schemaPath, REVIEW_SCHEMA);

  const lanes = REVIEW_LANES.map((lane) =>
    runOneLane({
      lane,
      snapshotDir,
      schemaPath,
      lastMessagePath: path.join(snapshotDir, `.auto-review.${lane.id}.last-message.json`),
      prompt: buildReviewPrompt({ lane, changedPaths, diff }),
      changedPaths,
      model
    })
  );
  return Promise.all(lanes);
}

function runOneLane({ lane, snapshotDir, schemaPath, lastMessagePath, prompt, changedPaths, model }) {
  return new Promise((resolve) => {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
      "--cd",
      snapshotDir
    ];
    if (model) args.push("-m", model);
    args.push("-c", 'model_reasoning_effort="high"', "-");

    const child = childProcess.spawn(codexBin(), args, {
      cwd: snapshotDir,
      env: {
        ...process.env,
        AUTO_REVIEW_CHILD: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve(failedLane(lane, `failed to spawn codex: ${error.message}`, stdout, stderr));
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        resolve(failedLane(lane, `codex exited with ${code ?? signal}`, stdout, stderr));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(lastMessagePath, "utf8"));
      } catch (error) {
        resolve(failedLane(lane, `could not read review JSON: ${error.message}`, stdout, stderr));
        return;
      }
      const validation = validateReviewResult(parsed, { changedPaths });
      if (!validation.ok) {
        resolve(failedLane(lane, `review JSON failed schema: ${validation.errors.join("; ")}`, stdout, stderr));
        return;
      }
      resolve({
        lane: lane.id,
        status: "completed",
        result: parsed,
        stdout,
        stderr,
        usage: parseUsage(stdout)
      });
    });
    child.stdin.end(prompt);
  });
}

function failedLane(lane, error, stdout, stderr) {
  return {
    lane: lane.id,
    status: "failed",
    error,
    stdout,
    stderr
  };
}

function parseUsage(stdout) {
  let usage = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      /* Ignore non-JSON log lines. */
    }
  }
  return usage;
}

module.exports = {
  runReviewLanes
};
