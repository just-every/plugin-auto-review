# Auto Code Review Plugin for Codex

Part of the [Just Every Codex plugin marketplace](https://github.com/just-every/plugins).

Auto Code Review gives Codex a peer programmer that reviews code as it is written. It runs a token-efficient review pass over the code the agent actually changed, catches meaningful regressions while the work is still fresh, and feeds clear findings back before the turn is allowed to finish.

The goal is fast, useful feedback without making the main agent reread the whole repository or perform its own second pass after the fact. Auto Code Review watches the diff, runs focused reviewer workers at Stop, and only interrupts when there is something real to fix.

Use it when you want AI coding sessions to feel more like pairing with a careful teammate: the main agent keeps building, while a focused review pass checks the diff for genuine bugs, regressions, broken contracts, and unsafe behavior. It is intentionally not a style, architecture, or preference review.

## Install

```bash
npx -y @just-every/plugin-auto-review setup
```

The setup helper runs the full happy path:

- `codex plugin marketplace add just-every/plugins`
- `codex plugin marketplace upgrade just-every`
- `codex plugin add auto-review@just-every`
- trust and enable the Auto Code Review hooks
- remove stale Auto Code Review custom-agent config

Auto Code Review can run immediately after setup. No custom agent or Codex restart is required.

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

`trust-hooks` uses Codex app-server `hooks/list` and `config/batchWrite`, the same config path the UI uses, to persist the current hook hashes under `hooks.state` and set them enabled.

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

Auto Code Review captures a lightweight baseline at the start of a turn and reviews the final baseline-to-stop diff when the turn tries to stop.

The Stop hook runs parallel Codex reviewer workers from writable per-lane job directories, with the captured final snapshot passed as read-only review context outside the worker cwd. Workers use schema-constrained output, `gpt-5.5`, medium reasoning, and default service tier. Clean reviews finish silently. Findings are returned through the hook as normal Stop feedback so the main agent can fix them immediately. After any review attempt, the final snapshot becomes the next baseline, so later Stops review only new changes. Review infrastructure failures write diagnostics to stderr and fail open.

- `hooks/hooks.json` defines `UserPromptSubmit` and `Stop`.
- Hook state is stored under `${PLUGIN_DATA}`.
- After each review attempt, the final snapshot becomes the next baseline, so later Stops review only new changes.
- The review workers write only under their review-job directory; the captured final snapshot is outside the worker cwd, treated as read-only review input, and removed after Stop advances the baseline.

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
