# Auto Review

Auto Review is a Codex plugin that runs code review from hooks. It captures a turn baseline on `UserPromptSubmit`, records successful `apply_patch` edits on `PostToolUse`, and reviews the final baseline-to-stop diff on `Stop`.

The review runner uses real `codex exec` subprocesses in parallel and validates every reviewer response against a strict JSON schema. If snapshotting, subprocess execution, or schema validation fails, the Stop hook blocks with a visible diagnostic.

## Install

```bash
set -euo pipefail

codex plugin marketplace add just-every/plugins
codex plugin marketplace upgrade just-every
codex plugin add auto-review@just-every
npx -y @just-every/plugin-auto-review trust-hooks
```

## Enable Hooks

Codex currently does not expose a first-class `codex plugin hooks enable` command. Plugin enablement and hook trust are separate: Auto Review can be installed and enabled while its hooks still require trust before they run.

The npm helper uses Codex app-server `hooks/list` and `config/batchWrite`, the same config path the UI uses, to persist the current hook hashes under `hooks.state` and set them enabled. To re-run it after installation:

```bash
npx -y @just-every/plugin-auto-review trust-hooks
```

The helper uses the directory where you run it to ask Codex which hooks are visible under the effective config. That directory does not need to be the installed plugin cache path. If you need to evaluate a different workspace, pass that workspace with `--cwd /path/to/workspace`.

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
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" .
npm pack --dry-run
```

## Release

The release workflow is `.github/workflows/release.yml`.

On relevant pushes to `main`, it runs the test suite, bumps `package.json` and `.codex-plugin/plugin.json`, publishes `@just-every/plugin-auto-review` to npm, tags the release, and creates a GitHub Release.

Required GitHub secret:

- `NPM_TOKEN`

Optional GitHub secret:

- `GH_PAT`, if branch protection blocks `GITHUB_TOKEN` from pushing release commits or tags
