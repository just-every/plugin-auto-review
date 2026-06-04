"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ensureDir, readJsonIfExists, safeSegment, writeJsonAtomic } = require("./state-store");

function writeEditMarker(paths, input) {
  ensureDir(paths.markersDir);
  const markerPath = path.join(paths.markersDir, `${safeSegment(input.tool_use_id)}.json`);
  writeJsonAtomic(markerPath, {
    session_id: input.session_id,
    turn_id: input.turn_id,
    cwd: input.cwd,
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    markedAt: new Date().toISOString()
  });
}

function readEditMarkers(paths) {
  try {
    return fs
      .readdirSync(paths.markersDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJsonIfExists(path.join(paths.markersDir, name)))
      .filter(Boolean)
      .sort((a, b) => String(a.markedAt).localeCompare(String(b.markedAt)));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

module.exports = {
  readEditMarkers,
  writeEditMarker
};
