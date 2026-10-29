---
name: published-load-direction
description: 2026-10-29 direction on fast published maps — fast published/viewer loads matter more than builder start-up; realtime multi-user draft editing still preferred; git-style local-first considered, not adopted; Postgres/Supabase variant documented as an option only
metadata:
  type: project
---

Decided in conversation 2026-10-29 (umbrella #182), after the import and
progress PRs (#195, #196) merged.

- Builder and project views may start slowly. Published maps, datasets and
  apps must load fast, including for the first viewer.
- The user still favors **realtime multi-user editing** of drafts. A
  git-style push/merge workflow was discussed and not adopted; row-click
  editing in the CMS must keep saving immediately, with a separate publish step.
- Publishing must not depend on one person's browser (future multi-user
  management), so published archives are to be built server-side from a frozen
  version.
- A second database is not adopted. An alternate self-hosted Postgres/Supabase
  version of the app is documented as an option only; no code or architecture
  changes planned. Revisit triggers are listed in the notes doc.
- The packed-snapshot design was shelved by the user for fear of complicating
  realtime edits, though the snapshot-plus-change-feed variant keeps them.

**Why:** the 20k-point cold open is dominated by Convex's per-document read
cost (see [[map-performance-audit-2026-10]]).

**How to apply:** before proposing load-time work, read
`docs/published-map-load-options-2026-10-29.md`; do not start the Postgres
variant without an ADR and the spike results.
