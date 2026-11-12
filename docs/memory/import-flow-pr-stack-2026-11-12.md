---
name: import-flow-pr-stack-2026-11-12
description: 2026-11-12 import-process fix stack — PRs #357/#358/#359 (.xls + %20 + code-view parity / GeoJSON feature-field preservation + preview / multistep + queue + error panel), key recipes and gotchas
metadata:
  type: project
---

# Import-flow PR stack (2026-11-12)

Three stacked PRs reconciling the import-process review, all browser-verified on
the compose dev stack (demo@jdm.test / "Views walkthrough" project):

- **#357** `fix/import-spreadsheet-basics` — `.xls` via SheetJS (`xlsx` installed
  from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` — the npm copy is
  stale/unpatched; exceljs reads only OOXML); `%20` fix = `uploadSourceFile`
  stores the RAW file name in the storage path (storage keeps decoded keys; the
  old `encodeURIComponent` double-encoded and leaked into `source_file_path`);
  signed download URLs now carry `download: <fileName>`; the Details card gained
  the Source-file row (the retention half had NO UI consumer before); the
  CodeMirror schema linter no longer warns about a missing `description`
  (`json-editor-impl.tsx objectMetaWarnings` — title stays the only required
  metadata, matching `schemaMetaError`).
- **#358** `feat/geojson-import-preserve-preview` — `parseGeoJsonFeatures`
  captures each feature's parent-level fields (outside type/geometry/properties)
  on the row WITHOUT touching data; `mergeFeatureFields` folds selections in
  (feature-level wins collisions, `collidingFeatureFields` flags them); `id` is
  the default-checked preservation. `GeoPreview` (new `geo-preview.tsx`) = inline
  SVG equirectangular sketch (2000-shape cap) + flagged list (geometry-less rows
  labeled by first string property + malformed-feature messages). Deliberately
  NOT MapLibre — the component package stays map-dep-free/SSR-safe.
- **#359** `feat/import-multistep-queue` — multistep stepper (Choose → Prepare &
  review → Import) driven by the importer's new `onPhaseChange` ("dropzone" →
  "review" → "importing"); multi-file drop enqueues an `ImportQueueItem[]`
  (statuses ready/reviewing/importing/done/failed, outcome-mirrored via effect
  on `status`); `onImport` gained a 9th `context` param (`fileName` +
  `remainingInQueue`) so the HOST holds the flow at a "Review next file" card
  instead of navigating mid-batch (`onResetProgress` clears the finished
  attempt's progress state); parse warnings list with sheet/line in the review
  screen (`ParseErrorsPanel`). Views/relationships inside import = deliberately
  deferred (design conversation, offered as follow-up).

**Why:** each fix's surface was invisible in code review alone (the `%20` only
existed in the DB row; the retention UI simply didn't exist) — browser + DB
verification caught the real shapes.

**How to apply:** repo lint traps hit repeatedly: optional chaining is an ERROR
(use `if (x !== undefined)` guard), `no-array-index-key` needs the disable
comment directly above the `key={i}` LINE inside JSX attrs, React-Compiler
`preserve-manual-memoization` bans useMemo in these render paths (derive
plainly, extract module-level helpers), complexity counts nested closures into
the enclosing function (extract to module level first, scoped `eslint/complexity`
disable is the repo precedent for orchestration components). IAB file upload is
unsupported — inject fixtures via base64→File→DataTransfer→synthetic `drop` on
the `[aria-label="Drop a data file here"]` element; cross-realm
`HTMLInputElement.prototype` value setters intermittently throw
"Illegal invocation" — prefer Playwright locators for text fills. SheetJS BIFF8
round-trips drop blank cells (test header synthesis with `" "` not `null`) and
an empty sheet still carries a dimension row (`[[]]` → skip on empty first
row). CI full dispatched on the stack tip per the minutes policy.
