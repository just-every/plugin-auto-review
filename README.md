# Auto Review

Auto Review is a Codex plugin that runs code review from hooks. It captures a turn baseline on `UserPromptSubmit`, records successful `apply_patch` edits on `PostToolUse`, and reviews the final baseline-to-stop diff on `Stop`.

The review runner uses real `codex exec` subprocesses in parallel and validates every reviewer response against a strict JSON schema. If snapshotting, subprocess execution, or schema validation fails, the Stop hook blocks with a visible diagnostic.

## Hooks

- `hooks/hooks.json` defines `UserPromptSubmit`, `PostToolUse` for `apply_patch`, and `Stop`.
- Hook state is stored under `${PLUGIN_DATA}`.
- Reviewer subprocesses run with `AUTO_REVIEW_CHILD=1`; hook scripts skip child sessions to avoid recursion.

## Development

Run:

```bash
npm test
python3 /Users/zemaj/.codex_zemaj/skills/.system/plugin-creator/scripts/validate_plugin.py .
```
