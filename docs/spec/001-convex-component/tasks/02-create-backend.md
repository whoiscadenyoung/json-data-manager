# Task: Create Convex Component Backend Files

Create the Convex component backend files for the JSON Data Manager package.

## Files to Create

All files go in `packages/json-data-manager/convex/`:

### 1. `convex/schema.ts` - Namespaced Table Definitions

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Store JSON schema definitions
  jdm_schemas: defineTable({
    title: v.string(),
    description: v.string(),
    schema: v.any(),
    slug: v.string(),  // URL-friendly identifier
    metadata: v.optional(v.record(v.string(), v.any())),  // Extensible metadata
  })
    .index("by_slug", ["slug"])
    .index("by_title", ["title"]),

  // Store entries for each schema
  jdm_entries: defineTable({
    schemaId: v.id("jdm_schemas"),
    data: v.any(),
    metadata: v.optional(v.record(v.string(), v.any())),
  })
    .index("by_schema", ["schemaId"])
    .index("by_schema_creation", ["schemaId", "_creationTime"]),
});
```

### 2. `convex/index.ts` - Public API Exports

```typescript
// Queries
export { listSchemas, getSchema, getSchemaBySlug } from "./schemas";
export { listEntries, getEntry, listEntriesPaginated } from "./entries";

// Mutations
export { createSchema, updateSchema, deleteSchema } from "./schemas";
export { createEntry, createBulkEntries, updateEntry, deleteEntry } from "./entries";

// Actions (if needed for external validation)
export { validateDataAgainstSchema } from "./validation";
```

### 3. `convex/schemas.ts` - Schema CRUD Operations

```typescript
import { query, mutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";

const SCHEMA_SIZE_LIMIT = 102400; // 100 KB

// Types for consumers
export interface SchemaInput {
  title: string;
  description: string;
  schema: unknown;
  slug?: string;
  metadata?: Record<string, unknown>;
}

// --- Queries ---

export const listSchemas = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let q = ctx.db.query("jdm_schemas").order("desc");

    if (args.cursor) {
      const cursorDoc = await ctx.db.get(args.cursor as Id<"jdm_schemas">);
      if (cursorDoc) {
        q = q.filter((q) => q.lt("_creationTime", cursorDoc._creationTime));
      }
    }

    const schemas = await (args.limit ? q.take(args.limit) : q.collect());
    return {
      schemas,
      nextCursor: schemas.length > 0 ? schemas[schemas.length - 1]._id : null,
    };
  },
});

export const getSchema = query({
  args: { schemaId: v.id("jdm_schemas") },
  handler: async (ctx, args) => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) throw new ConvexError("Schema not found");
    return schema;
  },
});

export const getSchemaBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("jdm_schemas")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

// Internal query for entry operations
export const _getSchemaInternal = internalQuery({
  args: { schemaId: v.id("jdm_schemas") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.schemaId);
  },
});

// --- Mutations ---

function validateSchemaSize(schema: unknown): void {
  const size = JSON.stringify(schema).length;
  if (size > SCHEMA_SIZE_LIMIT) {
    throw new ConvexError(`Schema exceeds ${SCHEMA_SIZE_LIMIT} bytes`);
  }
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const createSchema = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    schema: v.any(),
    slug: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("jdm_schemas"),
  handler: async (ctx, args): Promise<Id<"jdm_schemas">> => {
    // Validate required fields
    if (!args.schema || typeof args.schema !== "object") {
      throw new ConvexError("Schema must be a valid object");
    }

    const schemaObj = args.schema as Record<string, unknown>;
    if (!schemaObj.title || !schemaObj.description) {
      throw new ConvexError("Schema must have title and description properties");
    }

    validateSchemaSize(args.schema);

    // Ensure unique slug
    const slug = args.slug || generateSlug(args.title);
    const existing = await ctx.db
      .query("jdm_schemas")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();

    if (existing) {
      throw new ConvexError(`Schema with slug "${slug}" already exists`);
    }

    return await ctx.db.insert("jdm_schemas", {
      title: args.title,
      description: args.description,
      schema: args.schema,
      slug,
      metadata: args.metadata || {},
    });
  },
});

export const updateSchema = mutation({
  args: {
    schemaId: v.id("jdm_schemas"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
    slug: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) throw new ConvexError("Schema not found");

    const patch: Partial<typeof existing> = {};

    // Handle full schema update (restricted if entries exist)
    if (args.schema !== undefined) {
      // Check if entries exist
      const hasEntries = await ctx.db
        .query("jdm_entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .take(1)
        .then(r => r.length > 0);

      if (hasEntries) {
        throw new ConvexError(
          "Cannot modify schema structure when entries exist. " +
          "Delete all entries first or update metadata only."
        );
      }

      validateSchemaSize(args.schema);
      patch.schema = args.schema;

      // Sync title/description from schema object if present
      const s = args.schema as Record<string, unknown>;
      if (s.title) patch.title = String(s.title);
      if (s.description) patch.description = String(s.description);
    }

    // Metadata-only updates
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.metadata !== undefined) patch.metadata = args.metadata;

    // Slug update with uniqueness check
    if (args.slug !== undefined && args.slug !== existing.slug) {
      const slugTaken = await ctx.db
        .query("jdm_schemas")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug!))
        .unique();
      if (slugTaken) {
        throw new ConvexError(`Slug "${args.slug}" is already in use`);
      }
      patch.slug = args.slug;
    }

    await ctx.db.patch(args.schemaId, patch);
  },
});

export const deleteSchema = mutation({
  args: { schemaId: v.id("jdm_schemas") },
  handler: async (ctx, args) => {
    // Delete all associated entries first
    const entries = await ctx.db
      .query("jdm_entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();

    await Promise.all(entries.map(e => ctx.db.delete(e._id)));
    await ctx.db.delete(args.schemaId);
  },
});
```

### 4. `convex/entries.ts` - Entry CRUD Operations

```typescript
import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";

// --- Queries ---

export const listEntries = query({
  args: {
    schemaId: v.id("jdm_schemas"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let q = ctx.db
      .query("jdm_entries")
      .withIndex("by_schema_creation", (q) =>
        q.eq("schemaId", args.schemaId)
      )
      .order("desc");

    if (args.cursor) {
      const cursorDoc = await ctx.db.get(args.cursor as Id<"jdm_entries">);
      if (cursorDoc) {
        q = q.filter((q) => q.lt("_creationTime", cursorDoc._creationTime));
      }
    }

    const entries = await (args.limit ? q.take(args.limit) : q.collect());
    return {
      entries,
      nextCursor: entries.length > 0 ? entries[entries.length - 1]._id : null,
    };
  },
});

export const listEntriesPaginated = query({
  args: {
    schemaId: v.id("jdm_schemas"),
    pageSize: v.number(),
    cursor: v.optional(v.id("jdm_entries")),
  },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("jdm_entries")
      .withIndex("by_schema_creation", (q) =>
        q.eq("schemaId", args.schemaId)
      )
      .order("desc")
      .paginate(args);

    return entries;
  },
});

export const getEntry = query({
  args: { entryId: v.id("jdm_entries") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) throw new ConvexError("Entry not found");
    return entry;
  },
});

// --- Mutations ---

export const createEntry = mutation({
  args: {
    schemaId: v.id("jdm_schemas"),
    data: v.any(),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("jdm_entries"),
  handler: async (ctx, args): Promise<Id<"jdm_entries">> => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) throw new ConvexError("Schema not found");

    return await ctx.db.insert("jdm_entries", {
      schemaId: args.schemaId,
      data: args.data,
      metadata: args.metadata || {},
    });
  },
});

export const createBulkEntries = mutation({
  args: {
    schemaId: v.id("jdm_schemas"),
    dataArray: v.array(v.any()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.array(v.id("jdm_entries")),
  handler: async (ctx, args): Promise<Id<"jdm_entries">[]> => {
    const schema = await ctx.db.get(args.schemaId);
    if (!schema) throw new ConvexError("Schema not found");

    const ids = await Promise.all(
      args.dataArray.map((data) =>
        ctx.db.insert("jdm_entries", {
          schemaId: args.schemaId,
          data,
          metadata: args.metadata || {},
        })
      )
    );

    return ids;
  },
});

export const updateEntry = mutation({
  args: {
    entryId: v.id("jdm_entries"),
    data: v.optional(v.any()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) throw new ConvexError("Entry not found");

    const patch: Partial<typeof entry> = {};
    if (args.data !== undefined) patch.data = args.data;
    if (args.metadata !== undefined) patch.metadata = args.metadata;

    await ctx.db.patch(args.entryId, patch);
  },
});

export const deleteEntry = mutation({
  args: { entryId: v.id("jdm_entries") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.entryId);
  },
});
```

### 5. `convex/types.ts` - TypeScript Types

```typescript
import type { Id } from "./_generated/dataModel";

export interface Schema {
  _id: Id<"jdm_schemas">;
  _creationTime: number;
  title: string;
  description: string;
  schema: unknown;
  slug: string;
  metadata?: Record<string, unknown>;
}

export interface Entry {
  _id: Id<"jdm_entries">;
  _creationTime: number;
  schemaId: Id<"jdm_schemas">;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

### 6. `convex/validation.ts` - Validation Utilities

```typescript
import { action } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Placeholder for validation action
// This can be extended to use AJV for server-side validation
export const validateDataAgainstSchema = action({
  args: {
    schema: v.any(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    // TODO: Implement AJV validation
    // For now, just return valid
    return { valid: true, errors: [] };
  },
});
```

## Key Changes from Existing Code

### From `convex/schemas.ts` (existing app):
- Table renamed from `schemas` to `jdm_schemas`
- Added `slug` field with unique index
- Added `metadata` field for extensibility
- Added `listSchemas` with cursor-based pagination
- Added `getSchemaBySlug` query
- Added `deleteSchema` mutation with cascade delete
- Added protection against schema modification when entries exist
- Added `generateSlug` helper function
- Added `validateSchemaSize` helper (extracted from inline)

### From `convex/entries.ts` (existing app):
- Table renamed from `entries` to `jdm_entries`
- Added `metadata` field
- Added `by_schema_creation` compound index for efficient pagination
- Added `listEntriesPaginated` using Convex's built-in `.paginate()`
- Added `updateEntry` mutation (was missing in existing code)
- Added `deleteEntry` mutation (was missing in existing code)
- Maintained `createBulkEntries` for batch imports

## Notes

- All tables are prefixed with `jdm_` (JSON Data Manager) to avoid collisions with host app tables
- Uses cursor-based pagination for scalability
- Slug support enables human-friendly URLs
- The 100 KB schema size limit is preserved from existing code
- Schema structure cannot be modified when entries exist (prevents data corruption)
