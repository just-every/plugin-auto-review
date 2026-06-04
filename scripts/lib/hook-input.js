"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readHookInput(expectedEventName) {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    throw new Error("hook stdin was empty");
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    throw new Error(`hook stdin was not valid JSON: ${error.message}`);
  }

  requireString(input, "hook_event_name");
  if (input.hook_event_name !== expectedEventName) {
    throw new Error(`expected ${expectedEventName} hook input, received ${input.hook_event_name}`);
  }

  for (const field of ["cwd", "session_id", "turn_id", "model", "permission_mode"]) {
    requireString(input, field);
  }

  return input;
}

function requireString(input, field) {
  if (typeof input[field] !== "string" || input[field].trim() === "") {
    throw new Error(`hook input field ${field} must be a non-empty string`);
  }
}

function isChildSession(input) {
  if (process.env.AUTO_REVIEW_CHILD !== "1") return false;
  if (!process.env.AUTO_REVIEW_CHILD_CWD || !input || typeof input.cwd !== "string") return false;
  return path.resolve(input.cwd) === path.resolve(process.env.AUTO_REVIEW_CHILD_CWD);
}

module.exports = {
  isChildSession,
  readHookInput,
  requireString
};
