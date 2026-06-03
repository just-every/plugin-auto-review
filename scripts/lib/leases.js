"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ensureDir, safeSegment } = require("./state-store");

function acquireLease(paths, key) {
  ensureDir(paths.leasesDir);
  const leasePath = path.join(paths.leasesDir, `${safeSegment(key)}.json`);
  try {
    const fd = fs.openSync(leasePath, "wx");
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ key, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2)}\n`
    );
    fs.closeSync(fd);
    return { acquired: true, path: leasePath };
  } catch (error) {
    if (error.code === "EEXIST") {
      return { acquired: false, path: leasePath };
    }
    throw error;
  }
}

module.exports = {
  acquireLease
};
