"use strict";

function buildReviewPrompt({ snapshotDir, changedPaths, diff }) {
  return [
    "You are a Codex Auto Code Review worker.",
    "",
    "Review only the provided baseline-to-final diff and the files named in the changed path list.",
    snapshotDir ? `Repository snapshot root: ${snapshotDir}` : null,
    snapshotDir ? "Changed paths are relative to that snapshot root; use absolute paths under it if you inspect files." : null,
    "Your current working directory is review infrastructure, not the repository snapshot.",
    "Report only real, genuine, meaningful regressions introduced by the changed diff.",
    "A valid finding must describe a concrete failure mode: the changed code, the broken behavior or contract, and why it would fail for a realistic input or workflow.",
    "Only report findings important enough to block the turn until fixed.",
    "Do not report arbitrary architectural choices, alternate implementations, style, naming, formatting, organization, or preference-based design feedback.",
    "Do not report missing tests, speculative risks, broad maintainability concerns, or possible future issues unless the diff already contains a concrete bug they would expose.",
    "Do not report pre-existing problems that were not introduced or made worse by this diff.",
    "When in doubt, return no findings.",
    "Return only JSON that satisfies the provided schema.",
    "",
    "Changed paths:",
    changedPaths.map((file) => `- ${file}`).join("\n") || "- none",
    "",
    "Diff:",
    diff || "(empty diff)"
  ].filter((line) => line !== null).join("\n");
}

module.exports = {
  buildReviewPrompt
};
