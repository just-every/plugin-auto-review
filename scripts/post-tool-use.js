#!/usr/bin/env node
"use strict";

const { isChildSession, readHookInput, requireString } = require("./lib/hook-input");
const { writeContinue, writePostToolAdditionalContext } = require("./lib/hook-output");
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
  writeEditMarker(paths, input);
  writePostToolAdditionalContext("Auto Code Review marked this edited turn for a Stop checkpoint review.");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
