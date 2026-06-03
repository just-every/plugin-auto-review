"use strict";

function buildReviewPrompt({ lane, changedPaths, diff }) {
  return [
    "You are a Codex Auto Review worker.",
    `Review lens: ${lane.lens}`,
    "",
    "Review only the provided baseline-to-final diff and the files named in the changed path list.",
    "Identify correctness bugs, regressions, unsafe behavior, broken contracts, and missing edge-case handling.",
    "Do not report style-only issues. Do not infer beyond the changed scope.",
    "Return only JSON that satisfies the provided schema.",
    "",
    "Changed paths:",
    changedPaths.map((file) => `- ${file}`).join("\n") || "- none",
    "",
    "Diff:",
    diff || "(empty diff)"
  ].join("\n");
}

const REVIEW_LANES = [
  { id: "correctness", lens: "correctness and behavioral regressions" },
  { id: "edge-cases", lens: "edge cases, integration risks, and missing tests" }
];

module.exports = {
  REVIEW_LANES,
  buildReviewPrompt
};
