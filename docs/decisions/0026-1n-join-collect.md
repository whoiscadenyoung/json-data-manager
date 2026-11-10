# ADR 0026: 1-N joins collect every match as per-field arrays (`onDuplicateKey: "collect"`)

Date: 2026-11-10 · Status: accepted · Issue: [#288](https://github.com/whoiscadenyoung/json-data-manager/issues/288) ([remedies 2], the engine half of #282) ·
Train: [remedies umbrella #286] · Engine: `@caden/data-core` `lookup.ts` / `spec.ts`

## Context

A 1-N relation joined via "Join into a table" loses rows silently: the
lookup engine's duplicate-key policy ("first" default) keeps one lookup row
per key and drops the rest — one award, several corridors → the corridors
beyond the first are unreachable through any joined view. PR #285 made the
loss VISIBLE (`droppedLookupRows` in the stats line); this decision makes it
STOP for new joins. The output shape is the train's biggest ADR: preview,
export, popups, and app widgets all inherit it.

## Decision

**`onDuplicateKey: "collect"`** — a fourth value of the existing policy
union: when several lookup rows share one normalized key, every match's
fields land as a per-field ARRAY (`Ns.Corridor_Name: ["north", "south"]`),
in lookup-table order. Row count never changes; unmatched rows still land
the §6 null literal (not an empty array). Per-field arrays stay ALIGNED per
match (a row lacking a field contributes null, not a skip), so index _i_
reads one match across every brought-in column.

Rejected alternatives:

- **One row per match (explosion).** Changes row count — breaks the popup
  executor's one-entry-one-row contract ("never an error, never a dropped
  popup", #97), duplicates map features per match (heavy for
  geometry-bearing base rows), and shifts every downstream row-count
  assumption (stats denominators, exports, pagination). Rejected.
- **Aggregate (count + first fields).** Lossy by definition — the goal is
  non-lossy. Not lost as a capability: a rollup chained after a collect
  join can aggregate the arrays when a summary is what's wanted.
- **A single column of matched-row objects.** Preserves grouping but
  breaks the column model (one ragged blob column vs the namespaced
  columns every consumer already reads).

## Defaults and compatibility

- The ENGINE's omitted-field default stays `"first"` — stored specs keep
  their exact semantics; nothing re-reads differently.
- NEW joins write `"collect"` explicitly: the editor's empty operation
  defaults to it, the policy picker lists it first, and the relation's
  one-click "Join into a table" mint writes it. Legacy specs display
  their true resolved policy in the picker (the reader maps absent →
  "first") and switch by re-picking — no registry migration.
- Diagnostics: `droppedLookupRows` is 0 under collect; the new
  `collectedLookupRows` counts the rows "first" would have dropped — the
  stats line says which policy ran and what it did (#282's visibility
  rule, now symmetric).

## Consequences

- The geometry rule (`geometrySource`) reads the FIRST matched row under
  collect — references stay one-per-output-row; a join wanting a specific
  match's geometry uses a keeping policy. Documented + tested.
- Array cells render joined (`, `) in popups and the transform preview;
  exports carry the arrays as JSON values (the honest data shape).
- The popup executor needs no new error path — collect never throws.
