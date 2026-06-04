#!/usr/bin/env node
"use strict";

const { isChildSession, readHookInput } = require("./lib/hook-input");
const { writeContinue } = require("./lib/hook-output");
const { materializeSnapshot } = require("./lib/snapshot");
const { readJsonIfExists, turnPaths, writeJsonAtomic } = require("./lib/state-store");

function main() {
  const input = readHookInput("UserPromptSubmit");
  if (isChildSession()) {
    writeContinue();
    return;
  }

  const paths = turnPaths(input);
  try {
    if (readJsonIfExists(paths.baselineJson)) {
      writeContinue();
      return;
    }

    const baseline = materializeSnapshot(input.cwd, paths.baselineSnapshotDir);
    if (!baseline) {
      writeContinue();
      return;
    }

    writeJsonAtomic(paths.baselineJson, {
      ...baseline,
      session_id: input.session_id,
      turn_id: input.turn_id,
      model: input.model,
      permission_mode: input.permission_mode
    });
  } catch (error) {
    process.stderr.write(`Auto Code Review could not capture a baseline snapshot: ${error.message}\n`);
  }
  writeContinue();
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
