---
name: import-flow-pr-stack-2026-11-12
description: 2026-11-12 import-process + project-shell stack — PRs #357/#358/#359/#360 ALL MERGED to main same day (.xls + %20 + code-view parity / GeoJSON feature-field preservation + preview / multistep + queue + error panel / Add-new toolbar + Add-dataset page + publish → Settings), key recipes and gotchas
metadata:
  type: project
---

# Import-flow PR stack (2026-11-12) — 🏁 ALL MERGED (#357→#358→#359→#360, main @ 09bca6d, post-merge full gate green)

Four stacked PRs reconciling the import-process review + project-shell
rework, all browser-verified on the compose dev stack (demo@jdm.test /
"Views walkthrough" project):

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
- **#360** `feat/project-add-new-flow` — project toolbar collapsed to ONE
  "Add new" dropdown (Data group: Dataset/View; Compose group: Map/App);
  sidebar "Import" + "Publish" entries removed; `/create` is now the
  "Add dataset" page (Create-new cards — "Start from schema" renamed
  "Start from scratch" — above an Existing-datasets list with the
  Add-existing binding sheet); "Publish bundle" demoted to Settings →
  Publishing (press + bundle status; /publish route stays for deep links).
  TWO base-ui menu traps: `DropdownMenuLabel` (GroupLabel) must nest
  INSIDE its `DropdownMenuGroup` (outside = whole-menu crash), and
  `Menu.Item` fires `onClick` NOT Radix's `onSelect` (onSelect items
  render but silently do nothing).
