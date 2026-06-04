"use strict";

function formatReviewFailure(merged) {
  const lines = ["Auto Code Review failed before it could sign off on this turn."];
  for (const failure of merged.failures.slice(0, 4)) {
    lines.push(`- ${failure.lane}: ${failure.error}`);
    const stderr = String(failure.stderr || "").trim();
    if (stderr) lines.push(`  stderr: ${truncate(stderr, 500)}`);
  }
  return lines.join("\n");
}

function formatFindings(findings) {
  const lines = [`Auto Code Review found ${findings.length} issue${findings.length === 1 ? "" : "s"} to address before finishing.`];
  for (const finding of findings.slice(0, 10)) {
    const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    lines.push(`- [${finding.severity}] ${location} - ${finding.title}`);
    lines.push(`  ${finding.description}`);
    lines.push(`  Fix: ${finding.recommendation}`);
  }
  if (findings.length > 10) {
    lines.push(`- ${findings.length - 10} more findings omitted from the hook response; see result.json in plugin state.`);
  }
  return lines.join("\n");
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

module.exports = {
  formatFindings,
  formatReviewFailure
};
