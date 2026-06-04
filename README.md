# Auto Code Review

Auto Code Review is a Codex plugin that runs code review from hooks. It captures a turn baseline on `UserPromptSubmit`, records successful `apply_patch` edits on `PostToolUse`, and creates a review checkpoint on `Stop`.

When a checkpoint is pending, the Stop hook asks Codex to spawn or steer a visible `Auto Code Review` subagent. The subagent runs `$autoreview latest`, which uses real `codex exec` subprocesses in parallel and validates every reviewer response against a strict JSON schema. Clean reviews let the next Stop finish; findings and reviewer failures block with a visible diagnostic.

## Install

```bash
npx -y @just-every/plugin-auto-review setup
```

The setup helper runs the full happy path:

- `codex plugin marketplace add just-every/plugins`
- `codex plugin marketplace upgrade just-every`
- `codex plugin add auto-review@just-every`
- trust and enable the Auto Code Review hooks
- install or update `$CODEX_HOME/agents/auto-review.toml`

Auto Code Review can run immediately after setup. Reopen Codex when convenient to load the dedicated `auto-review` custom agent type for the nicer visible `Auto Code Review` subagent UI.

## Manual Setup

If you do not want the helper to run the Codex install commands, you can do the same steps manually:

```bash
codex plugin marketplace add just-every/plugins
codex plugin marketplace upgrade just-every
codex plugin add auto-review@just-every
```

Then trust the plugin hooks through the Codex `/hooks` UI, or run the compatibility helper:

```bash
npx -y @just-every/plugin-auto-review trust-hooks
```

`trust-hooks` uses Codex app-server `hooks/list` and `config/batchWrite`, the same config path the UI uses, to persist the current hook hashes under `hooks.state` and set them enabled. It also installs or updates the custom Auto Code Review agent.

Plugin enablement and hook trust are separate: Auto Code Review can be installed and enabled while its hooks still require trust before they run.

The helper uses the directory where you run it to ask Codex which hooks are visible under the effective config. That directory does not need to be the installed plugin cache path. If you need to evaluate a different workspace, pass that workspace with `--cwd /path/to/workspace`.

Use `--dry-run` to inspect setup without writing config or running Codex plugin install commands.

If Auto Code Review was installed from a different marketplace, pass its exact plugin id. For full setup this skips the Just Every marketplace add/upgrade and installs the requested plugin id directly:

```bash
npx -y @just-every/plugin-auto-review setup --plugin-id auto-review@local
```

For hook trust only:

```bash
npx -y @just-every/plugin-auto-review trust-hooks --plugin-id auto-review@local
```

`codex --dangerously-bypass-hook-trust` can run enabled hooks without persisted trust for a single invocation, but it is not a persistent setup command.

## Hooks

- `hooks/hooks.json` defines `UserPromptSubmit`, `PostToolUse` for `apply_patch`, and `Stop`.
- Hook state is stored under `${PLUGIN_DATA}`.
- Stop checkpoints are stored under `${PLUGIN_DATA}/checkpoints`.
- `$autoreview latest` reviews the latest pending checkpoint for the current session and repository.
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
