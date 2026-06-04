"use strict";

const assert = require("node:assert");
const test = require("node:test");

const { REVIEW_MODEL, REVIEW_REASONING, validateReviewModel } = require("../scripts/lib/codex-worker");

test("review worker uses valid model slug with separate medium reasoning", () => {
  assert.strictEqual(REVIEW_MODEL, "gpt-5.5");
  assert.strictEqual(REVIEW_REASONING, "medium");
  assert.doesNotThrow(() => validateReviewModel(REVIEW_MODEL));
  assert.throws(() => validateReviewModel("gpt-5.5-medium"), /unsupported Auto Code Review model/);
});
