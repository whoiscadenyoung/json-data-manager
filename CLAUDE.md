# Claude Instructions

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

<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`apps/web/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
