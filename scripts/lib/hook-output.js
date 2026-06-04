"use strict";

function writeHookOutput(output = {}) {
  process.stdout.write(JSON.stringify(output));
}

function writeContinue(output = {}) {
  writeHookOutput({ continue: true, ...output });
}

function writeStopBlock(reason) {
  writeHookOutput({
    continue: true,
    decision: "block",
    reason
  });
}

function writeStopMessage(systemMessage) {
  writeContinue({ systemMessage });
}

module.exports = {
  writeContinue,
  writeHookOutput,
  writeStopBlock,
  writeStopMessage
};
