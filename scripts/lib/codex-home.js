"use strict";

const os = require("node:os");
const path = require("node:path");

function resolveCodexHome(options = {}) {
  const raw = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return expandHome(raw);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

module.exports = {
  resolveCodexHome
};
