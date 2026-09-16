# AGENTS.md

## Project Memory

Project memory lives **inside this repo** at `docs/memory/` — not in any
user-level agent memory directory. The index is `docs/memory/MEMORY.md`.

- At the start of a session, read `docs/memory/MEMORY.md` and any entry
  relevant to the current task.
- When you learn something durable (user feedback, project constraints,
  non-obvious workflow), write a one-fact file into `docs/memory/` following
  the existing frontmatter format (name/description/type), and add one index
  line to `docs/memory/MEMORY.md`.
- Update an existing memory file rather than creating a duplicate; delete
  memories that turn out to be wrong.

## Git Commits

Always use the `/commit` skill when making git commits. Never run `git commit` directly.

- After completing a coding task, use the `git-commit` skill to stage and commit changes.
- The skill handles conventional commit message generation, intelligent staging, and proper formatting.
- Do not bypass the skill with raw `git commit` commands unless the user explicitly requests it.

## Use bun not node

We use bun, not node.
