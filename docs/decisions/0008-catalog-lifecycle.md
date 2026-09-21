# 8. Catalog lifecycle: projects are the virtual working layer; the published catalog is materialized

- Status: accepted
- Date: 2026-09
- Supersedes: ADR 0005's Projects deferral and its virtual-publish lean.
  ADR 0005's transformation decisions (declarative specs, virtual working
  layer, pure engine + two executors, client-side bulk computation) remain
  in force.

## Context

The desired end state, from worked scenarios: import a year's SMART grant
data into a workspace, put it on one map with layer groups, and publish the
map together with its underlying datasets as a bundle; and, separately, join
published tables (restaurants/locations/restaurantLocations) into one
flattened point dataset whose underlying sources may or may not be exposed.
Constraints: the published layer must remain the performance-optimized
materialized design (entries/geometries, extents, pagination, tile archives,
on-demand popups); imported data is never mutated; working state must
survive a crash; multi-user features remain behind the not-yet-landed auth
gating. The full design is
[`../catalog-lifecycle-design.md`](../catalog-lifecycle-design.md).

## Decision

- **Projects are the virtual working layer; the catalog is materialized;
  publish is the crossing.** Drafts (imports, transform specs, map
  arrangements) live in projects; publishing executes/materializes them into
  ordinary, frozen version datasets.
- **The catalog is append-only.** Republish creates a new immutable version;
  forks never merge back. Consumers pin a version or float, get in-app
  change notifications, diff via the existing version-delta machinery, and
  sync/revert by repinning (derived: re-run + re-freeze). This generalizes
  the shipped frozen-version machinery — no new versioning system.
- **Auto-publish dependencies; exposure decoupled.** A published map forces
  its layer datasets to publish; a materialized derived dataset references
  nothing live, so underlying sources publish only if separately chosen.
- **Bundle rule**: one project publishes as one bundle — a collection plus
  its maps plus the datasets they reference.
- **Concept mapping**: datasets are atomic and versioned; collections are
  promoted to publish bundles; groups are demoted to display folders with no
  lifecycle role; maps are artifacts in both layers.
- **Durability**: drafts are server-side documents saved early (autosave on
  edit); long publishes checkpoint and resume like the `syncRuns` engine.
- **Staging is unchanged at the front**: the transform engine, registry, and
  surfacing (ADR 0005 §10) come first; materialized publish, version
  sync/revert UX, and projects/sharing follow, with auth gating gating the
  last stage.

## Consequences

- Nothing published knows projects exist: published artifacts are shaped
  exactly like today's datasets/maps/collections, so every existing surface
  works unchanged and the entire change lives on the draft side.
- The engineering weight of the lifecycle is the materialized publish path
  (spec execution written through the existing ingest machinery,
  checkpointed) and the version sync/revert UX — both after the ADR 0005
  engine, so front-loaded plans don't change.
- Transform specs gain a `geometrySource` rule (derived rows can take
  geometry from a joined side of the spec).
- Groups stop accumulating responsibilities (display folders only);
  collections take on the publish-bundle role. No schema rework of
  groups/collections is required.
- Catalog consumers get provenance for free: every published dataset's
  lineage records its import source or its derivation recipe and source
  versions.
