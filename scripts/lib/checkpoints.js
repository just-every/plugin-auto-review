"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { maybeGitWorktree } = require("./git");
const { pluginDataRoot, safeSegment, writeJsonAtomic } = require("./state-store");

const UNRESOLVED_STATUSES = new Set(["pending", "running"]);

function checkpointIdForSnapshot(snapshotKey, input = {}) {
  return safeSegment(
    JSON.stringify({
      snapshotKey,
      sessionId: input.session_id || null,
      turnId: input.turn_id || null
    })
  ).slice(0, 16);
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
  if (!sessionId) {
    return readLatestCheckpointForCwd({ pluginData, cwd });
  }
  const root = checkpointRootFor({ pluginData, sessionId, cwd });
  const latestJson = path.join(root, "latest.json");
  const latest = readJson(latestJson);
  if (!latest) return null;
  const request = readJson(latest.requestJson);
  if (!request) return null;
  return { latest, request, paths: checkpointPathsFor({ pluginData, sessionId, cwd, checkpointId: request.id }) };
}

function readCheckpointForCwd({ pluginData, cwd, checkpointId }) {
  const checkpointsDir = path.join(path.resolve(pluginData), "checkpoints");
  const matches = [];
  for (const sessionSegment of readDirNames(checkpointsDir)) {
    const sessionRoot = path.join(checkpointsDir, sessionSegment);
    for (const repoSegment of readDirNames(sessionRoot)) {
      const root = path.join(sessionRoot, repoSegment);
      const latest = readJson(path.join(root, "latest.json"));
      const requestJson = path.join(root, "requests", safeSegment(checkpointId), "request.json");
      const request = readJson(requestJson);
      if (!request || request.id !== checkpointId) continue;
      if (!UNRESOLVED_STATUSES.has(request.status)) continue;
      if (!sameRepository(cwd, request)) continue;
      const cwdDistance = cwdMatchDistance(cwd, request.cwd);
      const paths = checkpointPathsFor({
        pluginData,
        sessionId: request.sessionId,
        cwd: request.cwd,
        checkpointId
      });
      matches.push({
        latest,
        request,
        paths,
        cwdDistance,
        updatedAt: Date.parse(request.updatedAt || latest?.updatedAt || request.createdAt || 0)
      });
    }
  }
  matches.sort(
    (a, b) =>
      a.cwdDistance - b.cwdDistance
      || b.updatedAt - a.updatedAt
  );
  return matches[0] || null;
}

function readLatestCheckpointForCwd({ pluginData, cwd }) {
  const checkpointsDir = path.join(path.resolve(pluginData), "checkpoints");
  const matches = [];
  for (const sessionSegment of readDirNames(checkpointsDir)) {
    const sessionRoot = path.join(checkpointsDir, sessionSegment);
    for (const repoSegment of readDirNames(sessionRoot)) {
      const root = path.join(sessionRoot, repoSegment);
      const latest = readJson(path.join(root, "latest.json"));
      if (!latest) continue;
      const request = readJson(latest.requestJson);
      if (!request) continue;
      if (!UNRESOLVED_STATUSES.has(request.status)) continue;
      if (!sameRepository(cwd, request)) continue;
      matches.push({
        latest,
        request,
        paths: checkpointPathsFor({
          pluginData,
          sessionId: latest.sessionId,
          cwd: request.cwd,
          checkpointId: request.id
        }),
        cwdDistance: cwdMatchDistance(cwd, request.cwd),
        updatedAt: Date.parse(request.updatedAt || latest.updatedAt || request.createdAt || 0)
      });
    }
  }
  matches.sort((a, b) => a.cwdDistance - b.cwdDistance || b.updatedAt - a.updatedAt);
  return matches[0] || null;
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

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function cwdMatchDistance(requestedCwd, checkpointCwd) {
  const requested = path.resolve(requestedCwd);
  const checkpoint = path.resolve(checkpointCwd);
  if (requested === checkpoint) return 0;
  const relativeFromRequested = path.relative(requested, checkpoint);
  if (relativeFromRequested && !relativeFromRequested.startsWith("..") && !path.isAbsolute(relativeFromRequested)) {
    return 1;
  }
  const relativeFromCheckpoint = path.relative(checkpoint, requested);
  if (relativeFromCheckpoint && !relativeFromCheckpoint.startsWith("..") && !path.isAbsolute(relativeFromCheckpoint)) {
    return 1;
  }
  return 2;
}

function sameRepository(cwd, request) {
  return repoRootFor(cwd) === (request.repoRoot ? path.resolve(request.repoRoot) : repoRootFor(request.cwd));
}

function repoRootFor(cwd) {
  return maybeGitWorktree(cwd) || path.resolve(cwd);
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
  readCheckpointForCwd,
  readLatestCheckpoint,
  readLatestCheckpointForCwd,
  updateCheckpointStatus,
  writeCheckpoint
};
