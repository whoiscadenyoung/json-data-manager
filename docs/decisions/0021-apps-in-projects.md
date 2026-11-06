# ADR 0021: Apps in projects — stored-map widgets, the app_versions freeze, and the layer-styles boundary amendment

Date: 2026-11-06 · Status: accepted · Issue: [#259](https://github.com/whoiscadenyoung/json-data-manager/issues/259) ·
Train: [project-centric umbrella #254], phase 5 · Design: `docs/project-centric-experience-design.md` §4.1, §5, §7 D7

## Context

[project 5] brings apps onto the project ladder: `apps.project_id` NOT NULL,
map widgets reference **stored project maps** (the inline `datasetIds` map
mode retires), and publishing freezes the app. Two decisions the issue left
to the implementer, recorded here:

## Decision

1. **The app freeze is an `app_versions` chain mirroring `layer_versions`**
   — not the bundle-member shape. `app_versions(id, app_id, version_label,
definition jsonb, created_by, created_at)` is append-only (no
   update/delete policies; the dataset/layer-version posture), newest row
   per app is the head, and the publish walk lives in the app-builder
   feature (`features/app-builder/lib/pg-app-publish.ts`). The `definition`
   snapshot is self-contained — title/description, the pages jsonb verbatim,
   `datasetPins` (head version + frozen meta per referenced dataset; no
   chain yet = honest nulls), `mapSnapshots` (per referenced map:
   name/viewport/basemap + placements as `{order, visible, versionId}`), and
   a flattened `layerVersions` list (each referenced layer_versions row's
   definition + resolved `{datasetId, versionId, ref}` + frozenChildren) —
   so the published viewer renders ONLY from the snapshot plus the immutable
   `version_entries`. Editing the live map cannot move a published app until
   republish. The bundle press stays the convenience closure over
   per-artifact publishes ([project 6]); reusing `publish_bundle_members`
   would couple per-app publishing to the collection press.
2. **Published rendering is snapshot-first.** `/apps/$appId` renders the
   head `app_version` when one exists; drafts, previews, and
   never-published apps render the live config. An owned layer with no
   version yet publishes first during the app's freeze (the publishLayer
   group-closure precedent); a layer WITH a version freezes its existing
   head — the next layer publish moves the NEXT app snapshot, exactly like
   a dataset pin.
3. **Writes are project-editor-gated** (the 0018 role split, the 0020 maps
   posture — the 0014 creator gate dies); the `revision` CAS save flow is
   unchanged; the seeded examples stay writable by no one, with ONE
   `example is true` arm on apps' SELECT keeping them readable by every
   signed-in viewer. `duplicate` targets a caller-chosen project and keeps
   map references only when the map is visible to the new owner (the
   datasets rule verbatim).
4. **layer-styles leaves the optional-module restricted list** (.oxlintrc.json).
   ADR 0012 wired the styling module only by routes; D7 makes styled stored
   maps load-bearing inside apps (the map widget renders the referenced
   map's layer styles), and ADR 0014's amended two-tier rule already lets
   domain features build on each other's public entries, acyclic. The
   `LayersMap` extension slot is unchanged; `app-builder` stays route-wired
   (the project workspace receives its create-app dialog through a
   route-level render-prop slot, the extension-slot pattern applied).

## Consequences

- `pg-app-publish.ts` sits in app-builder (not publishing) so publishing's
  workspace can import app-builder's dialog without a feature cycle.
- app_versions joins no realtime publication (republish is a deliberate
  action; TanStack invalidation covers the surfaces).
- Pre-0022 apps keep their rows (ownership backfill into per-creator
  projects) but their inline maps are NOT converted — no adoption steps.
