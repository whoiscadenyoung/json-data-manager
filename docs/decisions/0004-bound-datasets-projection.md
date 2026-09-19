# 4. Bound datasets: project foreign data, don't proxy it; the foreign app owns versioning

- Status: accepted
- Date: 2026-09-18 (design) — PoC shipped through phase 4; phase 5 (remote
  transport, #78) blocked on the hosting-fork decision
- Full design: [`docs/bound-datasets-design.md`](../bound-datasets-design.md)

## Context

A second Convex app owns data we want to render here — some geospatial
(lat/lng pairs), some not. Its tables must stay untouched until the apps
eventually merge, and it versions its data git-style: changes are commits,
point-in-time snapshots are tags. We want a live view plus browsable
snapshots and commit history in this app's map UI.

## Decision

- **Projection, not virtual tables.** Foreign rows are materialized into the
  component's `entries`/`geometries`, keyed by the foreign row's stable id.
  Every existing read path — pagination, denormalized summaries, tile
  archives, click-through — then works unchanged. Live-proxy rendering (page
  the foreign app per map open) was rejected: it would re-implement
  pagination, caching, and extent logic against a remote, forever.
- **json-cms mirrors; it never becomes a second versioning system.** The
  foreign app owns the commit graph and tags. This app stores the applied
  commit tail (`commits`) so history survives foreign log pruning, and
  freezes tag snapshots into separate read-only lineage datasets.
- **Bound datasets are read-only here.** Enforced twice: the component
  rejects data mutations on `source`/`lineage`-marked datasets unless the
  caller carries the host-only `boundWrite` attestation, and the host's
  `auth` gate gives the friendlier error first. Deleting a bound dataset
  goes through an explicit unbind flow, not the delete button.
- **Sources are descriptors.** A `BoundSource` (`app/convex/sources.ts`)
  declares the dataset to create, the field mapping, a full-state reader,
  and optionally a commit feed + geometry builder. The sync machinery is
  source-agnostic; adding a source is one registry entry. Co-deployed
  sources read host tables today; a remote source (#78) will implement the
  same interface over HTTP.
- **Sync is durable and keyed.** A run collects source rows into storage
  chunks, then applies them idempotently by foreign key through the
  `bindingEntries` map, checkpointed per batch — an interrupted run resumes
  exactly where it stopped, duplicating and losing nothing. Commit-tail sync
  is the primary path; a full pass is the fallback and the weekly
  reconcile's drift-repair pass.
- **Until the hosting question is settled, the foreign domain is a stand-in
  in this repo** — `restaurants`/`locations`/`restaurantLocations` tables, a
  `sourceCommits` feed, and snapshot JSONL, edited at `/dashboard`. They
  model the shape real foreign data is expected to take.

## Consequences

- The rendering/UI side needs zero special-casing for bound data beyond
  read-only markers and staleness badges.
- Sync cost is bounded by key-map diffs, not by clearing and reloading; a
  failed run leaves the projection consistent (possibly stale), never
  half-written.
- The eventual merge path is a source-implementation swap, not a redesign —
  but which side hosts the merged data is still an open decision (#78).
