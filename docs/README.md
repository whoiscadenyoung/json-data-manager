# Documentation

Start here: [`architecture.md`](./architecture.md) — what the system is, how
it is laid out, and how data flows. Then, for the reasoning behind it, the
[decision records](./decisions/).

## Layout

| Path                                                                           | What it is                                                                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](./architecture.md)                                         | The system: workspace layout, data model, backend/frontend structure, geometry paths, development. Kept current.                               |
| [`decisions/`](./decisions/)                                                   | Numbered decision records (ADR-style: context → decision → consequences). New decisions get the next number; superseded records stay.          |
| [`bound-datasets-design.md`](./bound-datasets-design.md)                       | Full design for rendering foreign Convex data (live projections, commit mirrors, tag versions) with shipped-PoC status and the phased roadmap. |
| [`map-performance-audit-2026-09-16.md`](./map-performance-audit-2026-09-16.md) | The performance audit behind the geometry/tile work (#48–#55). Historical record — measurements are still cited by the current design.         |
| [`gis-geometry-transport-survey.md`](./gis-geometry-transport-survey.md)       | Survey of how major GIS platforms move geometry to browsers; the rationale companion to the tile-archive path.                                 |
| [`memory/`](./memory/MEMORY.md)                                                | Project memory: durable lessons, verification gotchas, per-initiative records. Read/write policy lives in the repo `AGENTS.md`.                |

## Conventions

- **Memory (`docs/memory/`) is append-and-correct, never rewritten wholesale.**
  One fact per file with frontmatter, indexed by `memory/MEMORY.md`; update
  an existing entry rather than duplicating; delete entries that turn out to
  be wrong.
- **Decision records are immutable once accepted** — a reversal gets a new
  record that supersedes the old one.
- **Historical documents keep their date in the title or header** and are
  never edited into something they weren't; supersede them with a new doc
  instead.
