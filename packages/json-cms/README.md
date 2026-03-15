# Convex JSON CMS Component

A Convex component for managing JSON schemas and entries. This component provides a flexible content management system where you can define JSON schemas and store entries that conform to those schemas.

[![npm version](https://badge.fury.io/js/@caden%2Fjson-cms.svg)](https://badge.fury.io/js/@caden%2Fjson-cms)

## Installation

Create a `convex.config.ts` file in your app's `convex/` folder and install the component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import jsonCms from "@caden/json-cms/convex.config.js";

const app = defineApp();
app.use(jsonCms);

export default app;
```

## Component API

The component exposes the following functions under `components.jsonCms.lib`:

### Schema Operations

- `createSchema({ schema })` - Creates a new schema. Schema must have `title` and `description` properties.
- `listSchemas()` - Lists all schemas, ordered by creation time (newest first).
- `getSchema({ schemaId })` - Gets a single schema by ID. Returns `null` if not found.
- `updateSchema({ schemaId, title?, description?, schema? })` - Updates a schema. If `schema` is provided, it must have `title` and `description`.
- `deleteSchema({ schemaId })` - Deletes a schema and all its associated entries (cascade delete).

### Entry Operations

- `createEntry({ schemaId, data })` - Creates a new entry for a schema.
- `listEntries({ schemaId })` - Lists all entries for a schema, ordered by creation time (newest first).
- `getEntry({ entryId })` - Gets a single entry by ID. Returns `null` if not found.
- `createEntriesBulk({ schemaId, dataArray })` - Creates multiple entries in bulk.
- `updateEntry({ entryId, data })` - Updates an entry's data.
- `deleteEntry({ entryId })` - Deletes a single entry.
- `deleteEntriesBySchema({ schemaId })` - Deletes all entries for a schema. Returns the count of deleted entries.

### Size Limits

Schemas are limited to 100 KB (102400 bytes) when serialized to JSON. This limit is enforced on both `createSchema` and `updateSchema`.

## Usage Examples

### Direct Component Usage

```ts
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";

// Create a schema
export const createSchema = mutation({
  args: { schema: v.any() },
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.jsonCms.lib.createSchema, {
      schema: args.schema,
    });
  },
});

// List all schemas
export const listSchemas = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(components.jsonCms.lib.listSchemas, {});
  },
});

// Create an entry
export const createEntry = mutation({
  args: { schemaId: v.id("schemas"), data: v.any() },
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.jsonCms.lib.createEntry, args);
  },
});

// List entries for a schema
export const listEntries = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    return await ctx.runQuery(components.jsonCms.lib.listEntries, args);
  },
});
```

### Using the Client Helper

The component provides an `exposeApi` helper that wraps all component functions with authentication:

```ts
import { exposeApi } from "@caden/json-cms";
import { components } from "./_generated/api";

export const {
  listSchemas,
  getSchema,
  createSchema,
  updateSchema,
  deleteSchema,
  listEntries,
  getEntry,
  createEntry,
  createEntriesBulk,
  updateEntry,
  deleteEntry,
  deleteEntriesBySchema,
} = exposeApi(components.jsonCms, {
  auth: async (ctx, operation) => {
    const userId = await getAuthUserId(ctx);
    // Allow reads for anonymous users
    if (userId === null && operation.type === "read") {
      return "anonymous";
    }
    // Require auth for mutations
    if (userId === null) {
      throw new Error("Unauthorized");
    }
    return userId;
  },
});
```

### HTTP Routes

You can also expose HTTP endpoints for the component:

```ts
import { httpRouter } from "convex/server";
import { httpActionGeneric } from "convex/server";
import { components } from "./_generated/api";

const http = httpRouter();

// GET /schemas - list all schemas
http.route({
  path: "/schemas",
  method: "GET",
  handler: httpActionGeneric(async (ctx, _request) => {
    const schemas = await ctx.runQuery(components.jsonCms.lib.listSchemas, {});
    return new Response(JSON.stringify(schemas), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// GET /schemas/:id/entries - list entries for a schema
http.route({
  path: "/schemas/:schemaId/entries",
  method: "GET",
  handler: httpActionGeneric(async (ctx, request) => {
    const url = new URL(request.url);
    const schemaId = url.pathname.split("/")[2] as Id<"schemas">;
    const entries = await ctx.runQuery(components.jsonCms.lib.listEntries, {
      schemaId,
    });
    return new Response(JSON.stringify(entries), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
```

## Schema Definition

The component defines two tables:

### `schemas`
- `title: string` - Schema title (extracted from JSON schema)
- `description: string` - Schema description (extracted from JSON schema)
- `schema: any` - The full JSON schema object

### `entries`
- `schemaId: Id<"schemas">` - Reference to the parent schema
- `data: any` - The entry data conforming to the schema

The `entries` table has an index `by_schema` on `schemaId` for efficient querying.

## Development

```sh
# Install dependencies
npm i

# Start development (watches for changes)
npm run dev

# Run tests
bun run test

# Build the component
bun run build

# Publish
npm run alpha    # publish alpha version
npm run release  # publish stable version
```

See more example usage in [example/convex/example.ts](./example/convex/example.ts).

Found a bug? Feature request?
[File it here](https://github.com/whoiscadenyoung/json-data-manager/issues).
