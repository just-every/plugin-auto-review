#!/usr/bin/env node
"use strict";

const {
  autoReviewAgentInstalled,
  codexHomeFromPluginData,
  checkpointCommand,
  installAutoReviewAgent,
  installedPluginRoot,
  resolveCodexHome
} = require("./lib/agent-setup");
const { checkpointIdForSnapshot, writeCheckpoint } = require("./lib/checkpoints");
const { isChildSession, readHookInput } = require("./lib/hook-input");
const { writeContinue, writeStopBlock, writeStopMessage } = require("./lib/hook-output");
const { readEditMarkers } = require("./lib/edit-markers");
const { materializeSnapshot } = require("./lib/snapshot");
const { computeDiffScope } = require("./lib/diff-scope");
const { hashText, readJsonIfExists, turnPaths, writeJsonAtomic } = require("./lib/state-store");

async function main() {
  const input = readHookInput("Stop");
  if (isChildSession()) {
    writeContinue();
    return;
  }

  const paths = turnPaths(input);
  const markers = readEditMarkers(paths);

  const baseline = readJsonIfExists(paths.baselineJson);
  if (!baseline) {
    if (markers.length === 0) {
      writeContinue();
      return;
    }
    writeJsonAtomic(paths.receiptJson, failedReceipt("baseline", "edit markers existed but no captured baseline snapshot", markers));
    writeStopBlock("Auto Code Review could not run because this turn has edit markers but no captured baseline snapshot.");
    return;
  }

  const finalSnapshot = materializeSnapshot(input.cwd, paths.finalSnapshotDir);
  if (!finalSnapshot) {
    writeJsonAtomic(paths.receiptJson, failedReceipt("snapshot", "working directory is no longer a git worktree", markers));
    writeStopBlock("Auto Code Review could not run because the working directory is no longer a git worktree.");
    return;
  }
  writeJsonAtomic(paths.finalJson, finalSnapshot);

  let scope;
  try {
    scope = computeDiffScope(
      paths.baselineSnapshotDir,
      paths.finalSnapshotDir,
      baseline,
      finalSnapshot
    );
  } catch (error) {
    writeJsonAtomic(paths.receiptJson, failedReceipt("scope", error.message, markers));
    writeStopBlock(`Auto Code Review could not prepare the review scope: ${error.message}`);
    return;
  }

  if (scope.changedPaths.length === 0) {
    if (markers.length === 0) {
      writeContinue();
      return;
    }
    writeJsonAtomic(paths.receiptJson, {
      status: "clean",
      reason: "baseline and final snapshots matched",
      markers,
      snapshotKey: hashText(
        JSON.stringify({
          repo: finalSnapshot.repoRoot,
          base: baseline.treeHash,
          final: finalSnapshot.treeHash,
          changedPaths: scope.changedPaths
        })
      ),
      reviewedAt: new Date().toISOString()
    });
    writeStopMessage("Auto Code Review found no final code changes to review.");
    return;
  }

  const snapshotKey = hashText(
    JSON.stringify({
      repo: finalSnapshot.repoRoot,
      base: baseline.treeHash,
      final: finalSnapshot.treeHash,
      changedPaths: scope.changedPaths
    })
  );

  const receipt = readJsonIfExists(paths.receiptJson);
  if (receipt && receipt.snapshotKey === snapshotKey) {
    replayReceipt(receipt, scope.changedPaths.length);
    return;
  }

  const checkpointId = checkpointIdForSnapshot(snapshotKey, input);
  writeCheckpoint(input, {
    id: checkpointId,
    sessionId: input.session_id,
    turnId: input.turn_id,
    cwd: input.cwd,
    repoRoot: finalSnapshot.repoRoot,
    paths,
    receiptJson: paths.receiptJson,
    scope,
    markers,
    snapshotKey,
    createdAt: new Date().toISOString()
  });

  writeStopBlock(buildAgentInstruction(input, paths.root, checkpointId));
}

function failedReceipt(stage, error, markers) {
  return {
    status: "failed",
    stage,
    error,
    markers,
    reviewedAt: new Date().toISOString()
  };
}

function replayReceipt(receipt, changedPathCount) {
  if (receipt.status === "failed") {
    writeStopBlock("Auto Code Review could not complete this checkpoint. Check the Auto Code Review subagent output, then try finishing again.");
    return;
  }
  if (receipt.status === "findings") {
    const count = Number.isInteger(receipt.findingCount) ? ` ${receipt.findingCount}` : "";
    writeStopBlock(`Auto Code Review reported${count} issue${receipt.findingCount === 1 ? "" : "s"} for this checkpoint. Use the Auto Code Review subagent result, address the issues, then try finishing again.`);
    return;
  }
  writeStopMessage(`Auto Code Review checked ${changedPathCount} changed path${changedPathCount === 1 ? "" : "s"} and found no issues.`);
}

function buildAgentInstruction(input, pluginData, checkpointId) {
  const setup = ensureAgentSetup(pluginData, {
    cwd: input.cwd,
    checkpointId
  });
  if (!setup.ready) {
    const lines = [
      `Auto Code Review checkpoint ${checkpointId} is pending.`,
      setup.message,
      "Do not run the code review in this main thread."
    ];
    if (setup.fallbackCommand) {
      lines.push(
        "",
        "For this turn only, spawn a default subagent and ask that subagent to review this checkpoint itself.",
        "Context command for that subagent:",
        setup.fallbackCommand,
        "After reporting its review result, the subagent must run one receipt command from the context output."
      );
    }
    return lines.join("\n");
  }
  const lines = [
    `Auto Code Review checkpoint ${checkpointId} is pending.`,
    "Ask the `auto-review` subagent, shown as Auto Code Review, to review this checkpoint for this repository.",
    `Repository cwd: ${input.cwd}`,
    "",
    "Message for that subagent:",
    `Review Auto Code Review checkpoint ${checkpointId} for this repository. Repository cwd: ${input.cwd}`,
    ""
  ];
  if (setup.note) {
    lines.push(setup.note, "");
  }
  lines.push(
    "Do not run the code review in this main thread. Wait for the Auto Code Review subagent result, then try finishing again."
  );
  return lines.join("\n");
}

function ensureAgentSetup(pluginData, reviewTarget = {}) {
  const codexHome = codexHomeFromPluginData(pluginData) || resolveCodexHome();
  try {
    const pluginRoot = installedPluginRoot(codexHome);
    const agentOptions = {
      codexHome,
      pluginData,
      pluginRoot
    };
    const installed = autoReviewAgentInstalled(agentOptions);
    if (!pluginRoot) {
      if (installed) {
        return {
          ready: true,
          note: "Auto Code Review could not verify the installed plugin cache path. Using the existing subagent configuration; run `npx -y @just-every/plugin-auto-review setup` if the subagent cannot run the review."
        };
      }
      return {
        ready: false,
        message: "Auto Code Review could not find its installed plugin cache. Run `npx -y @just-every/plugin-auto-review setup`, reopen Codex if needed, then try finishing again."
      };
    }
    if (!installed) {
      const setup = installAutoReviewAgent(agentOptions);
      return {
        ready: false,
        message: `Installed the Auto Code Review subagent at ${setup.path}. Reopen Codex so the app loads it, then try finishing again.`,
        fallbackCommand: fallbackReviewCommand(agentOptions, reviewTarget)
      };
    }
    const setup = installAutoReviewAgent(agentOptions);
    if (setup.changed) {
      return {
        ready: false,
        message: "Auto Code Review updated its subagent configuration. Reopen Codex so the app loads the updated subagent instructions, then try finishing again.",
        fallbackCommand: fallbackReviewCommand(agentOptions, reviewTarget)
      };
    }
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      message: `Auto Code Review could not verify the custom subagent: ${error.message}. Run \`npx -y @just-every/plugin-auto-review setup\`, reopen Codex if needed, then try finishing again.`
    };
  }
}

function fallbackReviewCommand(options, reviewTarget) {
  return `${checkpointCommand({
    ...options,
    cwd: reviewTarget.cwd
  })} --checkpoint-id ${reviewTarget.checkpointId}`;
}

main().catch((error) => {
  writeStopBlock(`Auto Code Review could not prepare the checkpoint review: ${error.message}`);
});
