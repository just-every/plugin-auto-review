#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const args = process.argv.slice(2);
const lastMessageIndex = args.indexOf("--output-last-message");
if (lastMessageIndex === -1 || !args[lastMessageIndex + 1]) {
  process.stderr.write("missing --output-last-message\n");
  process.exit(64);
}

const lastMessagePath = args[lastMessageIndex + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (process.env.MOCK_CODEX_EXIT) {
    process.stderr.write("mock codex requested failure\n");
    process.exit(Number(process.env.MOCK_CODEX_EXIT));
  }

  if (process.env.MOCK_CODEX_INVALID_JSON === "1") {
    fs.writeFileSync(lastMessagePath, "{not json", "utf8");
  } else if (process.env.MOCK_CODEX_SCHEMA_MISMATCH === "1") {
    fs.writeFileSync(lastMessagePath, JSON.stringify({ findings: [] }), "utf8");
  } else if (process.env.MOCK_CODEX_INCORRECT_EMPTY === "1") {
    fs.writeFileSync(
      lastMessagePath,
      JSON.stringify({
        findings: [],
        overall_correctness: "incorrect",
        overall_explanation: "Incorrect without a concrete finding.",
        overall_confidence: "high"
      }),
      "utf8"
    );
  } else if (process.env.MOCK_CODEX_OUT_OF_SCOPE === "1") {
    fs.writeFileSync(
      lastMessagePath,
      JSON.stringify({
        findings: [
          {
            title: "Out of scope",
            severity: "medium",
            file: "other.js",
            line: 1,
            description: "This finding does not refer to the changed path.",
            recommendation: "Do not accept out-of-scope findings."
          }
        ],
        overall_correctness: "incorrect",
        overall_explanation: "Out-of-scope finding.",
        overall_confidence: "high"
      }),
      "utf8"
    );
  } else {
    fs.writeFileSync(lastMessagePath, JSON.stringify(mockReviewResult(stdin)), "utf8");
  }

  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "mock-thread" })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0
      }
    })}\n`
  );
});

function mockReviewResult(prompt) {
  if (process.env.MOCK_CODEX_FINDING === "1") {
    return {
      findings: [
        {
          title: "Broken behavior",
          severity: "high",
          file: "src/app.js",
          line: 1,
          description: "The changed code violates the expected behavior in the test fixture.",
          recommendation: "Restore the expected behavior before finishing."
        }
      ],
      overall_correctness: "incorrect",
      overall_explanation: "The mock review found a requested finding.",
      overall_confidence: "high"
    };
  }
  return {
    findings: [],
    overall_correctness: "correct",
    overall_explanation: `Reviewed prompt of ${prompt.length} bytes with no mock findings.`,
    overall_confidence: "high"
  };
}
