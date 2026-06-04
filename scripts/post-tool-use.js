#!/usr/bin/env node
"use strict";

const { isChildSession, readHookInput, requireString } = require("./lib/hook-input");
const { writeContinue } = require("./lib/hook-output");
const { writeEditMarker } = require("./lib/edit-markers");
const { maybeGitWorktree } = require("./lib/git");
const { turnPaths } = require("./lib/state-store");

function main() {
  const input = readHookInput("PostToolUse");
  if (isChildSession()) {
    writeContinue();
    return;
  }
  requireString(input, "tool_name");
  requireString(input, "tool_use_id");
  if (input.tool_name !== "apply_patch") {
    writeContinue();
    return;
  }
  if (!maybeGitWorktree(input.cwd)) {
    writeContinue();
    return;
  }

  const paths = turnPaths(input);
  try {
    writeEditMarker(paths, input);
  } catch (error) {
    process.stderr.write(`Auto Code Review could not record an edit marker: ${error.message}\n`);
  }
  writeContinue();
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
