"use strict";

const assert = require("node:assert");
const test = require("node:test");

const { REVIEW_MODEL, REVIEW_REASONING, validateReviewModel } = require("../scripts/lib/codex-worker");
const { buildReviewPrompt } = require("../scripts/lib/review-prompt");

test("review worker uses valid model slug with separate medium reasoning", () => {
  assert.strictEqual(REVIEW_MODEL, "gpt-5.5");
  assert.strictEqual(REVIEW_REASONING, "medium");
  assert.doesNotThrow(() => validateReviewModel(REVIEW_MODEL));
  assert.throws(() => validateReviewModel("gpt-5.5-medium"), /unsupported Auto Code Review model/);
});

test("review prompt asks only for meaningful regressions", () => {
  const prompt = buildReviewPrompt({
    snapshotDir: "/tmp/snapshot-final",
    changedPaths: ["src/app.js"],
    diff: "diff --git a/src/app.js b/src/app.js\n"
  });

  assert.match(prompt, /Repository snapshot root: \/tmp\/snapshot-final/);
  assert.match(prompt, /current working directory is review infrastructure/);
  assert.match(prompt, /real, genuine, meaningful regressions/);
  assert.match(prompt, /concrete failure mode/);
  assert.match(prompt, /important enough to block the turn/);
  assert.match(prompt, /Do not report missing tests/);
  assert.match(prompt, /When in doubt, return no findings/);
});
