---
name: auto-review
description: Explains the Auto Review plugin, which uses Codex hooks to capture turn baselines, record apply_patch edits, and run strict schema-validated code review at Stop.
---

# Auto Review

Auto Review is driven by plugin hooks:

- `UserPromptSubmit` captures a git-file snapshot at the start of a turn.
- `PostToolUse` records successful `apply_patch` edits as review markers.
- `Stop` compares the baseline snapshot with the final snapshot and runs parallel Codex review lanes.

Review worker output must satisfy the plugin's JSON schema. Invalid JSON, schema mismatches, snapshot failures, or subprocess failures are surfaced as failed reviews rather than inferred from prose.
