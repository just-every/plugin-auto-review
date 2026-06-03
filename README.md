# Auto Review

Auto Review is a Codex plugin that runs code review from hooks. It captures a turn baseline on `UserPromptSubmit`, records successful `apply_patch` edits on `PostToolUse`, and reviews the final baseline-to-stop diff on `Stop`.

The review runner uses real `codex exec` subprocesses in parallel and validates every reviewer response against a strict JSON schema. If snapshotting, subprocess execution, or schema validation fails, the Stop hook blocks with a visible diagnostic.

## Install

```bash
codex plugin marketplace add just-every/plugins
codex plugin marketplace upgrade just-every
codex plugin add auto-review@just-every
```

## Enable Hooks

Codex currently does not expose a first-class `codex plugin hooks enable` command. Plugin enablement and hook trust are separate: Auto Review can be installed and enabled while its hooks still require trust before they run.

This repo includes a helper that uses Codex app-server `hooks/list` and `config/batchWrite`, the same config path the UI uses, to persist the current hook hashes under `hooks.state` and set them enabled:

```bash
npm run trust-hooks -- --cwd /path/to/project
```

`--cwd` is the Codex project/workspace whose effective hook config should be inspected. Use the repo root you normally open in Codex; if you run the helper from that workspace, `--cwd "$PWD"` is fine.

Use `--dry-run` to inspect the hooks without writing config. If Auto Review was installed from a different marketplace, pass its exact plugin id, for example `--plugin-id auto-review@local`.

`codex --dangerously-bypass-hook-trust` can run enabled hooks without persisted trust for a single invocation, but it is not a persistent setup command.

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
