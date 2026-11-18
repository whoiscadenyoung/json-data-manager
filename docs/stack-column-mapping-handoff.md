# Handoff: Stack column mapping (rename, exclude, show merged columns)

Date: 2026-11-17 · Decision record: [ADR 0028](decisions/0028-views.md)
(addenda 2026-11-17 and 2026-11-17 b) · Design: [`views-design.md`](views-design.md)

## State of the repo

All work from the 2026-11-17 session is **uncommitted on `main`**: the Stack
(`append`) step, the Related (links) tab, migration `0035`, the Inputs panel
and the canvas input-edge change. Commit it first, with the `/commit` skill
(`AGENTS.md`), ideally as separate commits per theme (stack engine, links
tab + 0035, inputs panel + canvas). Migration 0035 is already applied to the
local `app` database. Typecheck, lint and unit tests were green at the time
of writing.

## What a Stack is

`{ kind: "append", sources: [{ input, tag? }], tagField?, baseTag? }`
(`packages/data-core/src/views/types.ts`). It compiles to `UNION ALL` of the
rows flowing in (`prev`) and each source input (`compileAppend` in
`chain.ts`). Rows keep their own geometry. Fields merge **by exact name**
(rows are jsonb `d`; a field a source lacks is simply absent on its rows).
A Stack is **not** a full outer join: it adds rows; a join matches rows on
keys and adds columns.

## The task

Let users see which columns merge across the stacked datasets, and rename,
re-map or exclude columns.

**Decided by the owner:** fields the user doesn't touch stay as they are
(included by default). A field is only dropped if explicitly excluded, and
only renamed if explicitly mapped. Existing stacks must not change.

### Model (plain JSON, no schema migration)

Add optional per-member column edits, applied to that member's rows before
the `UNION ALL`:

```ts
type ColumnEdit =
  | { from: string; as: string }       // rename / re-map into another output column
  | { from: string; exclude: true };   // drop the field for this member

type AppendSource = { input: string; tag?: AppendTag; columns?: ColumnEdit[] };
type AppendStep   = { ...; baseColumns?: ColumnEdit[] }; // edits for the incoming rows
```

Output column names are the union of what the members produce after edits.
Two members mapping into the same `as` merge into one column. A rename that
collides with an existing untouched field on the same member should be a
validation error (name the field). Geometry is unaffected.

### Compiler (`packages/data-core/src/views/`)

- `chain.ts` `compileAppend`: per member, build the object as
  `(d - 'a' - 'b') || jsonb_build_object('new', d -> 'old', ...)`, using bind
  parameters for every key (see `sql-util.ts`: `ParamBag`, `fieldJson`,
  `buildObject`). Never splice names into SQL. A rename of a field the row
  lacks must not create a null key (guard with `d ? 'old'`).
- `validate-steps.ts` `validateAppend`: shape of `columns` / `baseColumns`
  (`from` and `as` non-empty strings, no duplicate `from` within a member,
  `exclude` only with `true`). `validate-fields.ts` `applyAppend`: compute the
  known field map after edits (it currently unions raw field names), and
  report "Unknown field" for an edit whose `from` isn't on that member when
  that member's fields are known; report rename collisions.
- `reuse.ts`: `renameInputAlias` / `inputUsages` already handle `sources`;
  nothing to do for column edits unless an input is remapped to a dataset
  lacking the `from` fields (the remap report validates with the real
  validator, so it should surface that already; add a test).
- Golden tests: `compile.test.ts` / snapshots, plus a PGlite test next to
  `append.pglite.test.ts` proving rename, exclude, merge-into-one-column and
  that geometry survives.

### UI (`app/src/features/views/`)

`components/append-form.tsx` is the Stack form (Dataset | Tag table).
`lib/view-model.ts` has `fieldsAfterAppend` (editor-side field tracking; it
must apply the edits too) and `inputAliasOptions`.

Add a **Columns** section under the dataset table:

- One row per output column; one cell per member (incoming rows first, then
  each stacked dataset) showing the source field, or a gap.
- Status per row: **Merged** (present in every member), **Only in FY23, FY24**
  (partial), **Renamed**, **Excluded**.
- Inline: rename the output column (edits every member that feeds it);
  per-cell re-map ("use field X here", picking from that member's declared
  fields, `InputInfo.fields`); exclude toggle per cell or per row.
- Suggest likely merges (case/punctuation-insensitive match, same idea as
  `app/src/features/datasets/lib/link-suggestions.ts` `suggestKeys`) as
  one-click "merge these" chips, never applied silently.
- Fields come from `ctx.infos` (declared fields per input). When a member's
  fields are unknown, show the section collapsed with a note.

The preview pane already runs the step compile, so a mismatch shows live. The
canvas needs no change.

## Files you will touch

- `packages/data-core/src/views/{types,chain,validate-steps,validate-fields}.ts`,
  `index.ts` (export new types), tests (`append.pglite.test.ts`,
  `validate.test.ts`, `compile.test.ts`).
- `app/src/features/views/components/append-form.tsx`, a new
  `append-columns.tsx` (keep the form under the complexity limit),
  `lib/view-model.ts` (`fieldsAfterAppend`, plus a pure helper that derives
  the column table so it is unit-testable), tests next to them.
- `docs/decisions/0028-views.md` addendum and `docs/views-design.md` §4.

## Conventions and gotchas

- Use **bun**, not node. `bun run build` in `packages/data-core` regenerates
  `dist` (the app typechecks against it; rebuild after changing data-core
  types, or `app` tsc will not see them).
- Lint: `bunx oxlint --type-aware <files>` and `bunx oxfmt <files>`. The
  ruleset bans `?.`, `!`, `++`, and complexity over 10 is a warning (split
  components). Tests use `must()` from `test-fixtures-pglite.ts` instead of
  `?.`.
- Tests: `cd packages/data-core && bunx vitest run src/views`;
  `cd app && bunx vitest run src/features/views src/features/view-graphs`;
  `cd app && bunx tsc --noEmit`.
- Stored definitions are plain JSON; new fields are optional so existing
  views keep compiling.
- Browser check: `preview_start` with name `dev` (port 3000); sign in is
  already persisted for `demo@jdm.test` (see `docs/local-test-accounts.md`).
  The stacked view **SS4A IG Awards (FY22-FY24 stacked)** in "Traffic Safety
  Grants" (id `e3aad929-25a8-4a6b-99c3-c3f7b099ce32`) is a good fixture;
  FY22–FY24 awards share most field names but not all.
- Int tests that need the database: set `SUPABASE_DB_URL` to
  `postgresql://supabase_admin:<POSTGRES_PASSWORD from .env>@127.0.0.1:54322/app`
  (live compose db; run single tests with `-t`, see
  `docs/memory/int-test-db-split-ri-teardown.md`). This feature needs none.
- Known small quirk, optional: the dataset picker selects in step forms have
  no search box.

## Definition of done

- A user can open the Stack step, see merged vs partial columns across the
  stacked datasets, rename a column, re-map a differently named field into it,
  and exclude a field; the preview and a saved run reflect it.
- Untouched fields pass through exactly as before (existing stacked view
  output is unchanged: 155 rows, `fiscal_year` tag intact, geometry kept).
- Tests: compiler/golden, PGlite behavior, validator, the column-table helper,
  and the form. Docs: ADR addendum + design §4. Lint, typecheck and the
  suites above green.
