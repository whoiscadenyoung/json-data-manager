# Task: Create Convex Component Backend Files

Create the Convex component backend files for the JSON CMS package by copying and refactoring the existing app's Convex logic into component format.

## Overview

This task involves copying the existing Convex backend logic from the main app's `convex/` directory and refactoring it into a reusable Convex component structure under `packages/json-cms/`.

## Files to Create

All files go in `packages/json-cms/convex/`:

### 1. `convex/schema.ts` - Table Definitions

Copy from the existing app's `convex/schema.ts` and adapt:

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Store JSON schema definitions
  schemas: defineTable({
    title: v.string(),
    description: v.string(),
    schema: v.any(),
  }),

  // Store entries for each schema
  entries: defineTable({
    schemaId: v.id("schemas"),
    data: v.any(),
  })
    .index("by_schema", ["schemaId"])
    .index("by_schema_creation", ["schemaId", "_creationTime"]),
});
```

### 2. `convex/index.ts` - Public API Exports

```typescript
// Queries
export { listSchemas, getSchema } from "./schemas";
export { listEntries, getEntry } from "./entries";

// Mutations
export { createSchema, updateSchema } from "./schemas";
export { createEntry, createBulkEntries, updateEntry, deleteEntry } from "./entries";
```

### 3. `convex/schemas.ts` - Schema CRUD Operations

Copy and refactor from `convex/schemas.ts` in the existing app:

```typescript
import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";

const SCHEMA_SIZE_LIMIT = 102400; // 100 KB

// --- Queries ---

export const listSchemas = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("schemas").order("desc").collect();
  },
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }
    return schema;
  },
});

// --- Mutations ---

export const createSchema = mutation({
  args: {
    schema: v.any(),
  },
  handler: async (ctx, args) => {
    if (!args.schema.title || !args.schema.description) {
      throw new ConvexError("Schema must have 'title' and 'description' properties");
    }

    const schemaStr = JSON.stringify(args.schema);
    if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
      throw new ConvexError("Schema exceeds the 100 KB size limit.");
    }

    const schemaId = await ctx.db.insert("schemas", {
      title: args.schema.title,
      description: args.schema.description,
      schema: args.schema,
    });

    return schemaId;
  },
});

export const updateSchema = mutation({
  args: {
    schemaId: v.id("schemas"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    const patch: Record<string, unknown> = {};

    if (args.schema !== undefined) {
      if (!args.schema.title || !args.schema.description) {
        throw new ConvexError("Schema must have 'title' and 'description' properties");
      }
      const schemaStr = JSON.stringify(args.schema);
      if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("Schema exceeds the 100 KB size limit.");
      }
      patch.schema = args.schema;
      patch.title = args.schema.title;
      patch.description = args.schema.description;
    } else {
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
    }

    await ctx.db.patch(args.schemaId, patch);
  },
});
```

### 4. `convex/entries.ts` - Entry CRUD Operations

Copy and refactor from `convex/entries.ts` in the existing app:

```typescript
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

// --- Queries ---

export const listEntries = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }

    return await ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .order("desc")
      .collect();
  },
});

export const getEntry = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) {
      throw new Error("Entry not found");
    }
    return entry;
  },
});

// --- Mutations ---

export const createEntry = mutation({
  args: {
    schemaId: v.id("schemas"),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }

    const entryId = await ctx.db.insert("entries", {
      schemaId: args.schemaId,
      data: args.data,
    });

    return entryId;
  },
});

export const createBulkEntries = mutation({
  args: {
    schemaId: v.id("schemas"),
    dataArray: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) {
      throw new Error("Schema not found");
    }

    const ids = await Promise.all(
      args.dataArray.map((data) =>
        ctx.db.insert("entries", { schemaId: args.schemaId, data })
      ),
    );

    return ids;
  },
});

export const updateEntry = mutation({
  args: {
    entryId: v.id("entries"),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) {
      throw new Error("Entry not found");
    }

    const patch: Record<string, unknown> = {};
    if (args.data !== undefined) patch.data = args.data;

    await ctx.db.patch(args.entryId, patch);
  },
});

export const deleteEntry = mutation({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.entryId);
  },
});
```

### 5. `package.json` - Component Package Configuration

Create the package.json for the component:

```json
{
  "name": "json-cms",
  "version": "0.1.0",
  "description": "Convex component for JSON-based content management",
  "type": "module",
  "exports": {
    "./convex": {
      "import": "./convex/index.ts"
    }
  },
  "files": [
    "convex"
  ],
  "peerDependencies": {
    "convex": "^1.0.0"
  },
  "devDependencies": {
    "convex": "^1.0.0",
    "typescript": "^5.0.0"
  }
}
```

## Steps to Complete

1. Create the directory structure:
   ```bash
   mkdir -p packages/json-cms/convex
   ```

2. Copy and adapt the schema definition from the existing app's `convex/schema.ts`

3. Copy and refactor `convex/schemas.ts` logic, renaming exports to be component-friendly (e.g., `list` -> `listSchemas`)

4. Copy and refactor `convex/entries.ts` logic, adding any missing mutations like `updateEntry` and `deleteEntry`

5. Create the `convex/index.ts` barrel export file

6. Create the `package.json` with proper Convex component configuration

7. Install dependencies:
   ```bash
   cd packages/json-cms && bun install
   ```

## Key Refactoring Notes

### From `convex/schemas.ts` (existing app):
- Keep table name as `schemas` (not prefixed) since this is a standalone component
- Preserve the 100 KB size limit check
- Maintain validation for required `title` and `description` fields
- Rename `list` to `listSchemas` for clarity in component exports
- Rename `get` to `getSchema` for clarity
- Rename `create`/`update` to `createSchema`/`updateSchema`

### From `convex/entries.ts` (existing app):
- Keep table name as `entries` (not prefixed)
- Add `by_schema_creation` compound index for efficient pagination
- Rename `list` to `listEntries`
- Rename `get` to `getEntry`
- Rename `create` to `createEntry`, `createBulk` to `createBulkEntries`
- Add `updateEntry` mutation (if not in existing code)
- Add `deleteEntry` mutation (if not in existing code)

## Notes

- Table names remain `schemas` and `entries` (no prefix) since this is a standalone component that will be namespaced by the host app's component installation
- The 100 KB schema size limit is preserved from existing code
- Uses the same validation logic as the existing app
- Component structure allows the host app to import and use these functions via the Convex component system
