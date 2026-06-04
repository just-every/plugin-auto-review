"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { pluginDataRoot, safeSegment, writeJsonAtomic } = require("./state-store");

function checkpointIdForSnapshot(snapshotKey) {
  return safeSegment(snapshotKey).slice(0, 16);
}

function checkpointRoot(input) {
  return checkpointRootFor({
    pluginData: pluginDataRoot(),
    sessionId: input.session_id,
    cwd: input.cwd
  });
}

function checkpointRootFor({ pluginData, sessionId, cwd }) {
  return path.join(path.resolve(pluginData), "checkpoints", safeSegment(sessionId), safeSegment(path.resolve(cwd)));
}

function checkpointPaths(input, checkpointId) {
  return checkpointPathsFor({
    pluginData: pluginDataRoot(),
    sessionId: input.session_id,
    cwd: input.cwd,
    checkpointId
  });
}

function checkpointPathsFor({ pluginData, sessionId, cwd, checkpointId }) {
  const root = checkpointRootFor({ pluginData, sessionId, cwd });
  const dir = path.join(root, "requests", safeSegment(checkpointId));
  return {
    root,
    dir,
    latestJson: path.join(root, "latest.json"),
    requestJson: path.join(dir, "request.json"),
    statusJson: path.join(dir, "status.json")
  };
}

function writeCheckpoint(input, checkpoint) {
  const paths = checkpointPaths(input, checkpoint.id);
  const request = {
    ...checkpoint,
    status: checkpoint.status || "pending",
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(paths.requestJson, request);
  writeJsonAtomic(paths.latestJson, {
    id: checkpoint.id,
    requestJson: paths.requestJson,
    sessionId: input.session_id,
    cwd: input.cwd,
    updatedAt: request.updatedAt
  });
  return { paths, request };
}

function readLatestCheckpoint({ pluginData, sessionId, cwd }) {
  const root = checkpointRootFor({ pluginData, sessionId, cwd });
  const latestJson = path.join(root, "latest.json");
  const latest = readJson(latestJson);
  if (!latest) return null;
  const request = readJson(latest.requestJson);
  if (!request) return null;
  return { latest, request, paths: checkpointPathsFor({ pluginData, sessionId, cwd, checkpointId: request.id }) };
}

function updateCheckpointStatus(checkpoint, fields) {
  const now = new Date().toISOString();
  const request = {
    ...checkpoint.request,
    ...fields,
    updatedAt: now
  };
  writeJsonAtomic(checkpoint.paths.requestJson, request);
  writeJsonAtomic(checkpoint.paths.statusJson, {
    id: request.id,
    status: request.status,
    updatedAt: now
  });
  checkpoint.request = request;
  return request;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

module.exports = {
  checkpointIdForSnapshot,
  readLatestCheckpoint,
  updateCheckpointStatus,
  writeCheckpoint
};
