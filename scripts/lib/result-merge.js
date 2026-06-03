"use strict";

function mergeReviewResults(laneResults) {
  const failures = laneResults.filter((lane) => lane.status !== "completed");
  if (failures.length > 0) {
    return {
      status: "failed",
      failures,
      findings: [],
      laneResults
    };
  }

  const findingsByKey = new Map();
  for (const lane of laneResults) {
    for (const finding of lane.result.findings) {
      const key = [
        finding.file,
        finding.line === null ? "" : finding.line,
        finding.title.toLowerCase()
      ].join("\0");
      if (!findingsByKey.has(key)) {
        findingsByKey.set(key, { ...finding, lanes: [lane.lane] });
      } else {
        findingsByKey.get(key).lanes.push(lane.lane);
      }
    }
  }

  const findings = [...findingsByKey.values()].sort(compareFindings);
  const incorrect = laneResults.some((lane) => lane.result.overall_correctness === "incorrect");
  return {
    status: findings.length > 0 || incorrect ? "findings" : "clean",
    findings,
    laneResults
  };
}

function compareFindings(a, b) {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  return (
    severityOrder[a.severity] - severityOrder[b.severity] ||
    a.file.localeCompare(b.file) ||
    Number(a.line ?? 0) - Number(b.line ?? 0)
  );
}

module.exports = {
  mergeReviewResults
};
