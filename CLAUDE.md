# Claude Instructions

## Git Commits

Always use the `/commit` skill when making git commits. Never run `git commit` directly.

- After completing a coding task, use the `git-commit` skill to stage and commit changes.
- The skill handles conventional commit message generation, intelligent staging, and proper formatting.
- Do not bypass the skill with raw `git commit` commands unless the user explicitly requests it.
