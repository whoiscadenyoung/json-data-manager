---
name: views-output-and-exports
description: "#303 gotchas — output keys/labels/hidden live in definition.output (with a new `from` for renames), export profiles (migration 0030), layer popup defaults from the view"
metadata:
  type: project
---

2026-11-10, #303.

- **Labels/hidden/emptyFields live in `definition.output`, NOT
  `datasets.output_settings`** (one source of truth; the validator ignores
  extra keys anyway). `output_settings` stays unused.
- **An output `key` used to be only a SELECTION of source fields** (the
  compiler projected `d` by key). Renaming needed a new optional
  `OutputField.from` (source field; defaults to `key`). Compiler: when any
  field has `from != key` it builds `jsonb_object_agg(key, d -> from)` from a
  `[[key, from], ...]` param; otherwise the old SQL (snapshots unchanged).
  Validation checks `from ?? key` against the row scope, and duplicate KEYS.
  `output.fields = []` still means "every field as named"; the Output card
  (`features/views/lib/output-model.ts`) collapses back to `[]` when nothing
  differs, and keeps left-out fields after the kept ones.
- **Hidden fields stay in the saved rows** (usable by styling); only tooltips
  and exports drop them. ArcGIS name warnings skip hidden fields.
- **Export profiles** = table `export_profiles` (0030, RLS follows
  `can_view_dataset` / `can_edit_dataset`), settings jsonb
  `{format, propertyNames, emptyFields, precision}`. The serializer is pure
  (`features/views/lib/export-profile.ts`); the card reads the SAVED
  definition's output (`savedOutput` state, updated on Save) and the saved
  entries/geometries (`fetchDatasetEntryRows`, `resolveDatasetGeometryRows`;
  geometry key = entry id). Importing `#/features/datasets` from views creates
  an import cycle (lint `no-cycle`): use `#/lib/dataset-rows-pg` directly.
- **Layer popups:** `layers.popup` was a dead jsonb column. Now
  `null` = "from view" (visible output fields, labelled, in order, via
  `view_definition`), `{fields:[{key,label}]}` = per-layer override, reset =
  write `null`. LayersMap takes `popupFieldsFor`; wired in the map editor and
  `StoredMapCanvas`. NOT wired in `frozen-map-canvas` (published apps), and
  `view_definition` is granted to `authenticated` only, so anonymous viewers
  see every property.
- Local checks need `bun install` + `packages/json-cms` `bun run build`
  (dist) before `bun run lint`/`build` in a fresh worktree.

Related: [[views-initiative]], [[views-editor-and-derived-retire]], [[views-compiler-notes]].
