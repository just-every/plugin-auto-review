---
name: autoreview
description: Run the Auto Code Review checkpoint requested by the Stop hook and report the result without editing repository files.
---

# Auto Code Review

Use this skill when the parent thread asks you to run `$autoreview latest` or
to review an Auto Code Review checkpoint.

Rules:

- Do not edit repository files.
- Do not apply fixes.
- Do not start additional agents.
- Run the exact shell command supplied by the Stop hook when it is present.
- Report stdout verbatim. If the command fails, report stderr and the exit code.

The Stop hook normally supplies a command shaped like:

```bash
node "<plugin-root>/scripts/autoreview.js" latest --plugin-data "<plugin-data>" --session "<session-id>" --cwd "<repo-cwd>"
```

That command finds the latest pending checkpoint for the current session and
repository, runs the schema-validated review, persists the result, and prints
the review summary.
