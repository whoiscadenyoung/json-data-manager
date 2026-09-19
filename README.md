# JSON Data Manager

A geospatial JSON data manager: define datasets with JSON Schema, import rows
(JSON / CSV / XLSX / GeoJSON), browse and edit them in tables and on maps,
organize them into collections and groups, and compose saved map views. It
also renders data owned by another Convex app as read-only **bound datasets**,
complete with git-style commit history and frozen tag versions.

The core data layer is a reusable [Convex](https://convex.dev) component —
[`@caden/json-cms`](./packages/json-cms/) — which any Convex app can install.
This repo's app is a thin host on top of it: a TanStack Start frontend plus
the Convex functions that re-export the component's API and add the
bound-datasets sync engine.

## Repo layout

| Path | What it is |
| --- | --- |
| `app/` | The application — TanStack Start (React 19) in `app/src`, Convex host functions in `app/convex`. |
| `packages/json-cms/` | `@caden/json-cms` — the CMS Convex component, its typed client, and React hooks/UI. |
| `packages/geometry-archive/` | `@caden/geometry-archive` — PMTiles archive writer for the map tile pipeline. |
| `packages/data-export/` | `@caden/data-export` — snapshot-export component (built, not yet wired in). |
| `docs/` | Architecture, decision records, design docs, and project memory. |

## Getting started

Requires [bun](https://bun.sh).

```bash
bun install
bun run dev
```

This starts Convex dev alongside Vite; the app serves at
[localhost:3000](http://localhost:3000). The dev deployment is selected via
`app/.env.local`. If the cloud deployment is unavailable, the local-backend
recipe lives in `docs/memory/` — plain `bunx convex dev` from `app/` can
re-select cloud and rewrite that file.

## Development

```bash
bun run test        # app tests (vitest)
bun run lint        # oxlint, type-aware, from the root
bun run fmt         # oxfmt
bunx tsc --noEmit   # typecheck the app (run from app/)
```

Notes that bite:

- Changes to `packages/json-cms` need `bun run build` inside that package
  before the app sees them — the app consumes `dist`.
- `bun run test` covers the app only; json-cms has its own suite
  (`bun run test` from `packages/json-cms/`).
- The component's tables are namespace-isolated from the app's own tables;
  see [docs/architecture.md](./docs/architecture.md) for the full data model.

## Documentation

Start with the [docs index](./docs/README.md):

- [Architecture](./docs/architecture.md) — how the system fits together.
- [Decision records](./docs/decisions/) — why it is the way it is.
- [Bound datasets design](./docs/bound-datasets-design.md) — the foreign-data
  integration (live projections, commits, tags).
