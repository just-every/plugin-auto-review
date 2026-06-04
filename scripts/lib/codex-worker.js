"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { REVIEW_SCHEMA, validateReviewResult } = require("./review-schema");
const { REVIEW_LANES, buildReviewPrompt } = require("./review-prompt");
const { ensureDir, writeJsonAtomic } = require("./state-store");

const REVIEW_MODEL = "gpt-5.5";
const REVIEW_REASONING = "medium";
const REVIEW_SERVICE_TIER = "default";
const REVIEW_LANE_TIMEOUT_MS = 120000;
const ALLOWED_REVIEW_MODELS = new Set(["gpt-5.5"]);

function codexBin() {
  const bin = process.env.AUTO_REVIEW_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex";
  if (!bin.trim()) {
    throw new Error("AUTO_REVIEW_CODEX_BIN or CODEX_CLI_PATH must not be empty");
  }
  return bin;
}

async function runReviewLanes({
  snapshotDir,
  jobDir,
  changedPaths,
  diff,
  model = REVIEW_MODEL,
  reasoning = REVIEW_REASONING,
  serviceTier = REVIEW_SERVICE_TIER
}) {
  validateReviewModel(model);
  fs.rmSync(jobDir, { recursive: true, force: true });
  ensureDir(jobDir);

  const lanes = REVIEW_LANES.map((lane) =>
    runOneLane({
      lane,
      snapshotDir,
      laneDir: path.join(jobDir, "lanes", lane.id),
      prompt: buildReviewPrompt({ lane, snapshotDir, changedPaths, diff }),
      changedPaths,
      model,
      reasoning,
      serviceTier
    })
  );
  return Promise.all(lanes);
}

function runOneLane({ lane, snapshotDir, laneDir, prompt, changedPaths, model, reasoning, serviceTier }) {
  return new Promise((resolve) => {
    ensureDir(laneDir);
    const schemaPath = path.join(laneDir, "review-schema.json");
    const lastMessagePath = path.join(laneDir, "last-message.json");
    writeJsonAtomic(schemaPath, REVIEW_SCHEMA);

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
      "--cd",
      laneDir
    ];
    if (model) args.push("-m", model);
    args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`);
    args.push("-c", `service_tier=${JSON.stringify(serviceTier)}`);
    args.push("-");

    const timeoutMs = reviewLaneTimeoutMs();
    const child = childProcess.spawn(codexBin(), args, {
      cwd: laneDir,
      env: {
        ...process.env,
        AUTO_REVIEW_CHILD: "1",
        AUTO_REVIEW_CHILD_CWD: laneDir,
        AUTO_REVIEW_SNAPSHOT_DIR: snapshotDir
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    const timeout = setTimeout(() => {
      finish(failedLane(lane, `review lane timed out after ${timeoutMs}ms`, stdout, stderr));
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000);
      killTimer.unref();
      child.unref();
    }, timeoutMs);
    timeout.unref();

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(failedLane(lane, `failed to spawn codex: ${error.message}`, stdout, stderr));
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(failedLane(lane, `codex exited with ${code ?? signal}`, stdout, stderr));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(lastMessagePath, "utf8"));
      } catch (error) {
        finish(failedLane(lane, `could not read review JSON: ${error.message}`, stdout, stderr));
        return;
      }
      const validation = validateReviewResult(parsed, { changedPaths });
      if (!validation.ok) {
        finish(failedLane(lane, `review JSON failed schema: ${validation.errors.join("; ")}`, stdout, stderr));
        return;
      }
      finish({
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

function reviewLaneTimeoutMs() {
  const raw = process.env.AUTO_REVIEW_LANE_TIMEOUT_MS;
  if (!raw) return REVIEW_LANE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("AUTO_REVIEW_LANE_TIMEOUT_MS must be a number >= 1");
  }
  return Math.floor(parsed);
}

function validateReviewModel(model) {
  if (!ALLOWED_REVIEW_MODELS.has(model)) {
    throw new Error(`unsupported Auto Code Review model: ${model}`);
  }
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
  REVIEW_MODEL,
  REVIEW_REASONING,
  REVIEW_SERVICE_TIER,
  REVIEW_LANE_TIMEOUT_MS,
  runReviewLanes,
  validateReviewModel
};
