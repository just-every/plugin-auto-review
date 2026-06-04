# Auto Code Review Plugin for Codex

Part of the [Just Every Codex plugin marketplace](https://github.com/just-every/plugins).

Auto Code Review gives Codex a peer programmer that reviews code as it is written. It runs a token-efficient review pass over the code the agent actually changed, catches meaningful regressions while the work is still fresh, and feeds clear findings back before the turn is allowed to finish.

Use it when you want AI coding sessions to feel more like pairing with a careful teammate. The main agent keeps building, while Auto Code Review checks the diff for genuine bugs, regressions, broken contracts, and unsafe behavior. It is intentionally not a style, architecture, or preference review.

## Install

```bash
codex plugin marketplace add just-every/plugins
codex plugin marketplace upgrade just-every
codex plugin add auto-review@just-every
```

Then open `/hooks` in Codex, trust the Auto Code Review hooks, and make sure they are enabled.

Auto Code Review can run immediately after install. No custom agent or Codex restart is required.

Plugin installation and hook trust are separate in Codex. If the plugin is installed but nothing happens at Stop, check `/hooks` first.

## How It Works

Auto Code Review captures a baseline at the start of a turn, then reviews the baseline-to-stop diff when the turn tries to finish.

Clean reviews finish silently. Real findings are returned as normal Stop feedback so the main agent can fix them immediately. After any review attempt, the final snapshot becomes the next baseline, so later Stops review only new changes.

- `hooks/hooks.json` defines `UserPromptSubmit` and `Stop`.
- Hook state is stored under `${PLUGIN_DATA}`.
- Review workers use schema-constrained output, `gpt-5.5`, medium reasoning, and default service tier.
- Review infrastructure failures write diagnostics to stderr and fail open.

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
