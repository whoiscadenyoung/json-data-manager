# @caden/data-export

A generic **data export** component for [Convex](https://www.convex.dev).

Snapshot any set of tables to flat JSON files in Convex file storage at a single
point in time — a lot like the `npx convex export` CLI command, but as a
component you can call from your own app, on demand or on a schedule.

- **Generic** — works with any Convex app and any tables. You tell it which
  tables (or supply your own reader) and it exports them.
- **Durable** — orchestrated with [`@convex-dev/workflow`](https://www.convex.dev/components/workflow),
  so a large export makes resumable, retryable progress table-by-table.
- **Batched** — each table is streamed in pages, so no single query has to read
  a whole table at once.
- **Self-describing** — each export is a "folder": one
  `<table>/documents.jsonl` file per table plus a `_manifest.json` recording the
  export date, tables, paths, and row/byte counts.

The exported files are the plain JSON representation of your documents (including
`_id` and `_creationTime`), one document per line — the same shape as a
`convex export` snapshot. That makes them a clean input for later analysis and
transformation (e.g. DuckDB) and for generating downloads in other formats
(GeoJSON, Excel, …). Those transforms are **not** part of this component yet —
see [Roadmap](#roadmap).

## Installation

```bash
npm install @caden/data-export @convex-dev/workflow @convex-dev/workpool
```

## Setup

### 1. Install the component in your app

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import dataExport from "@caden/data-export/convex.config.js";

const app = defineApp();
app.use(dataExport);

export default app;
```

### 2. Register a table reader and expose the API

The component runs in its own isolated environment, so it can't read your tables
directly. You give it a tiny **reader** — a generic paginated query over your
own data model, produced by `exportReader()` — and it pages through your tables
by calling it.

```ts
// convex/exports.ts
import { exportReader, exposeApi } from "@caden/data-export";
import { components, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server"; // or your own auth

// Registered as an internal function, so it's never exposed to clients.
export const readTablePage = exportReader();

export const {
  startExport,
  cancelExport,
  deleteExport,
  listExports,
  getExport,
  getExportFiles,
  getDownloadUrls,
} = exposeApi(components.dataExport, {
  reader: internal.exports.readTablePage,
  // Exports read your entire tables — authorize carefully.
  auth: async (ctx, op) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return userId;
  },
});
```

Your clients can now call `api.exports.startExport`, `api.exports.listExports`,
`api.exports.getDownloadUrls`, and so on.

## Usage

### Start an export

```ts
// From any of your own mutations/actions, using the low-level helper:
import { startExport } from "@caden/data-export";
import { components, internal } from "./_generated/api";

const exportId = await startExport(ctx, components.dataExport, {
  tableNames: ["users", "posts"],
  reader: internal.exports.readTablePage,
  batchSize: 1000, // optional, documents per page (default 1000)
  label: "nightly", // optional
});
```

Or from a client, through the exposed API:

```ts
const exportId = await convex.mutation(api.exports.startExport, {
  tableNames: ["users", "posts"],
});
```

The call returns immediately with an `exportId`. The export runs in the
background; poll it or subscribe to it:

```ts
const exp = await convex.query(api.exports.getExport, { exportId });
// exp.status: "pending" | "running" | "completed" | "failed" | "canceled"
// exp.requestedAt / exp.completedAt / exp.totalRows / exp.totalBytes
```

### Download the results

```ts
const { manifestUrl, files } = await convex.query(api.exports.getDownloadUrls, {
  exportId,
});
// files: [{ tableName, path, rowCount, sizeBytes, url }, ...]
```

Each `url` is a time-limited Convex storage URL for the table's
`documents.jsonl`. `manifestUrl` points at the `_manifest.json` for the whole
snapshot:

```json
{
  "version": 1,
  "exportId": "...",
  "exportedAt": 1788220218217,
  "exportedAtISO": "2026-08-31T23:50:18.217Z",
  "format": "jsonl",
  "schemaVersion": "e523d76e",
  "tables": [
    {
      "table": "users",
      "path": "users/documents.jsonl",
      "rowCount": 8,
      "sizeBytes": 975,
      "schema": {
        "type": "object",
        "value": { "email": { "fieldType": { "type": "string" }, "optional": false } }
      }
    }
  ],
  "totalRows": 16,
  "totalBytes": 2348
}
```

Each table's `schema` is the Convex validator JSON captured at export time (see
[Reading exports back & schema evolution](#reading-exports-back--schema-evolution)),
or `null` for a schemaless table.

### Manage exports

```ts
await convex.query(api.exports.listExports, { status: "completed", limit: 20 });
await convex.mutation(api.exports.cancelExport, { exportId }); // while running
await convex.mutation(api.exports.deleteExport, { exportId }); // removes files too
```

## Reading exports back & schema evolution

A point-in-time snapshot is only useful later if you know what shape the data
was in when it was written — tables drift as your app changes. This component
addresses that in two parts.

### 1. Capture the schema at export time

Pass your `defineSchema(...)` result to `startExport`/`exposeApi`. For each
exported table the component stores its **Convex validator JSON** (`.json`) plus
a `schemaVersion` (an explicit label you pass, or an automatic hash of the
captured shapes). It's recorded on the export row, on each file row, and in
`_manifest.json` — so every snapshot is self-describing, even years later.

```ts
import schema from "./schema";
export const { startExport /* … */ } = exposeApi(components.dataExport, {
  reader: internal.exports.readTablePage,
  schema, // capture each table's declared shape
  auth: async () => {
    /* … */
  },
});
```

Tables without a declared validator (schemaless) still export — they just have
no recorded shape.

### 2. Read back with a typed codec + upcasters

`defineExportCodec` gives you a stable, typed view of a table regardless of when
the snapshot was taken. `current` is a Convex validator (decoded rows are typed
`Infer<current>` — the "fields I know exist"); `upcasters`, keyed by the
snapshot's `schemaVersion`, migrate older rows forward.

```ts
import { defineExportCodec, readExportTable } from "@caden/data-export";

const usersCodec = defineExportCodec({
  current: v.object({ email: v.string(), fullName: v.string() }),
  upcasters: {
    // a snapshot written under this version stored `name` instead of `fullName`
    a1b2c3d4: (doc) => ({ email: doc.email, fullName: doc.name }),
  },
});
```

**On the backend** — read a table back into a Convex action as typed rows:

```ts
export const importUsers = action({
  args: { exportId: v.string() },
  handler: async (ctx, { exportId }) => {
    const users = await readExportTable(ctx, components.dataExport, {
      exportId: exportId as ExportId,
      table: "users",
      codec: usersCodec,
    });
    // users: { email: string; fullName: string }[] — upcast from whatever
    // version the snapshot used.
  },
});
```

**On the frontend** — the codec is plain isomorphic TS, so download a file via
its URL and decode it the same way:

```ts
import { decodeExportText } from "@caden/data-export";

const res = await fetch(fileUrl);
const users = decodeExportText(await res.text(), schemaVersion, usersCodec);
```

`exposeApi` also exposes a `readTable` action so a client can paginate rows
through the backend (`{ exportId, tableName, cursor?, numItems? }`) and apply the
codec itself.

> The `readTable` action reads a table's file into memory to slice a page; for
> very large tables page with a modest `numItems` (or the future part-file mode).

## How it works

```
startExport ─▶ exports row (status: running, requestedAt) ─▶ workflow
                                                              │
                     for each table (durable, retryable step)│
                        exportTable ── pages via your reader ─┤ (batched)
                                    └─ writes <table>/documents.jsonl to storage
                                    └─ records an exportFiles row
                     finalize ── writes _manifest.json ───────┤
                     onComplete ── status: completed, completedAt
```

- The component owns two tables (`exports`, `exportFiles`) and its own file
  storage, so it is fully self-contained and works alongside any app schema.
- Each table is one durable workflow step, streamed in `batchSize` pages. To fan
  tables out in parallel, the workflow can be switched to run steps under
  `Promise.all` (see `src/component/workflows.ts`).

> **Note on very large tables:** a table's file is assembled in memory before it
> is stored, so extremely large tables are bounded by an action's memory. A
> future part-file mode (one file per batch) is planned for unbounded sizes.

## Example

A complete runnable example lives in [`example/`](./example): an app with
`users`/`posts` tables, a reader, the exposed API, and a small React dashboard.

```bash
npm run dev:local   # runs a local Convex backend + the example
```

## Testing

Run the test suite:

```bash
npm test
```

The component's metadata/storage layer and the generic reader are covered with
[`convex-test`](https://github.com/get-convex/convex-test). The **full workflow
run** (streaming, file writes, manifest, completion) is validated against a real
Convex backend rather than `convex-test`, because `@convex-dev/workflow` patches
the shared JS global scope in ways `convex-test` can't drive to completion. See
the example for an end-to-end run.

## Roadmap

The exported flat files are designed to be the substrate for a future analysis
layer (not yet built):

- Query and transform exports with **DuckDB**.
- Generate downloads in other formats — **GeoJSON**, **Excel** workbooks, CSV.

## License

Apache-2.0
