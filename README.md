# Auto Code Review Plugin for Codex

Part of the [Just Every Codex plugin marketplace](https://github.com/just-every/plugins).

Auto Code Review gives Codex a peer programmer that reviews code as it is written. It runs a continuous, token-efficient review loop alongside the main agent, catches issues while the work is still fresh, and feeds clear findings back before the turn is allowed to finish.

The goal is fast, useful feedback without making the main agent reread the whole repository or wait for a heavy review pass after the fact. Auto Code Review watches the code the agent actually changed, asks a dedicated reviewer to inspect that checkpoint, and only interrupts when there is something real to fix.

Use it when you want AI coding sessions to feel more like pairing with a careful teammate: the main agent keeps building, while a focused reviewer checks the diff for bugs, regressions, missed edge cases, and unsafe assumptions.

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

## How It Works

Auto Code Review captures a lightweight baseline at the start of a turn, notices when Codex edits files, and creates a review checkpoint when the turn tries to stop. A visible `Auto Code Review` subagent reviews the changed code with bounded reviewer subprocesses and schema-validated output.

Clean reviews let the next Stop finish. Findings and reviewer failures block completion with a visible diagnostic so the main agent can fix the issue immediately.

- `hooks/hooks.json` defines `UserPromptSubmit`, `PostToolUse` for `apply_patch`, and `Stop`.
- Hook state is stored under `${PLUGIN_DATA}`.
- Stop checkpoints are stored under `${PLUGIN_DATA}/checkpoints`.
- The Auto Code Review subagent reviews the latest pending checkpoint for the current repository.
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
