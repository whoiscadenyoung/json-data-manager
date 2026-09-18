# Agent Kickoffs — geometry tile cache (#59–#63)

Ordered handoff prompts for implementing #58 in five parts. Pass ONE file to
each agent session, in order. Each file names what to read first, the task,
hard constraints, verification, and what to fill in from the previous part's
actual results.

**Ground rules for every kickoff:**

1. One part per agent session. Never start the next part.
2. Read `docs/memory/MEMORY.md` and the entries listed in the kickoff before
   editing anything.
3. Use `bun` (never node/npm); commits via the repo's `git-commit` skill;
   PR flow per the memory note `pr-merge-sync-flow` (branch off fresh main,
   `gh pr create --head <branch>`, `gh pr merge --merge`, `git fetch --prune`,
   delete branch).
4. When the part lands: append what actually shipped (real names/exports,
   measured numbers, surprises) to `docs/memory/geometry-tile-breakdown.md`
   before handing off the next kickoff.

| File | Issue | Ships |
|---|---|---|
| [part-1-geometry-archive.md](./part-1-geometry-archive.md) | #59 | `@caden/geometry-archive` — GeoJSON → MVT → PMTiles v3 writer + tests |
| [part-2-schema-and-versioning.md](./part-2-schema-and-versioning.md) | #60 | schema fields, version bumps, `setMapTileArchive` guard, meta API |
| [part-3-archive-worker.md](./part-3-archive-worker.md) | #61 | client worker: generate/upload/install, debounced single-flight rebuilds |
| [part-4-render-from-tiles.md](./part-4-render-from-tiles.md) | #62 | maps render from tile archives above threshold; hot-swap; chip semantics |
| [part-5-opfs-and-persister.md](./part-5-opfs-and-persister.md) | #63 | OPFS archive pin + TanStack Query persister (light state) |

Parent: #58 (survey doc: `docs/gis-geometry-transport-survey.md`).

**COMPLETE 2026-09-18** — all five parts landed (PRs #64–#68, one per part);
#58, #51, and #63 closed. What actually shipped per part lives in
`docs/memory/geometry-tile-breakdown.md`; the per-part files above are kept as
historical handoffs (each was amended by its successor where reality diverged).
