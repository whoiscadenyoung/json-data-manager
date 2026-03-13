# Convex Component Plan: JSON Data Manager

## Overview

Convert the JSON Data Manager backend and frontend into a reusable, publishable Convex component that others can install as a headless CMS. The component will provide:

1. **Backend**: Complete Convex component with schema definitions, CRUD operations, and validation
2. **Frontend (Optional)**: React hooks and unstyled/presentational components that can be imported and customized

---

## Part 1: Convex Component Structure

### 1.1 Directory Layout

```
convex/
├── component/
│   ├── convex.json              # Component manifest (describes exports)
│   ├── schema.ts                # Component schema definitions
│   ├── index.ts                 # Main entry point - exports public API
│   ├── schemas.ts               # Schema management (internal mutations/queries)
│   ├── entries.ts               # Entry management (internal mutations/queries)
│   ├── validation.ts            # Shared validation logic
│   └── types.ts                 # Shared TypeScript types
└── (existing app code)
```

### 1.2 Component Configuration

**`convex/component/convex.json`**:
```json
{
  "name": "@json-data-manager/cms",
  "version": "1.0.0",
  "exports": {
    "./api": "./index.ts",
    "./types": "./types.ts"
  },
  "dependencies": {}
}
```

### 1.3 Schema Design (Component Isolation)

Components use namespaced tables to avoid collisions with host app tables:

```typescript
// convex/component/schema.ts
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

### 1.4 Public API Surface

**`convex/component/index.ts`** - Functions exported to consuming apps:

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

### 1.5 Implementation: schemas.ts

```typescript
import { query, mutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";

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

### 1.6 Implementation: entries.ts

```typescript
import { query, mutation, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

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

### 1.7 Implementation: types.ts

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

---

## Part 2: Frontend Integration

### 2.1 Approach Options

Since Convex components currently only export backend functions, the frontend components can be distributed in two ways:

| Approach | Pros | Cons |
|----------|------|------|
| **A. Monorepo with separate npm package** | Full control, tree-shakeable, versioned | More setup, separate publish workflow |
| **B. Git submodule/subtree** | Consumer gets code they can modify | Harder to update, duplication |
| **C. Copy-paste recipe** | Simplest, no build step | No updates, drift from source |

**Recommendation**: Use **Approach A** with a monorepo containing:
- `packages/convex-component/` - The Convex backend component
- `packages/react/` - React hooks and headless components

### 2.2 Monorepo Structure

```
json-data-manager/
├── apps/
│   └── demo/                    # Demo app (current app becomes demo)
├── packages/
│   ├── convex-cms/              # Convex component (published to npm)
│   │   ├── convex/
│   │   │   ├── component/
│   │   │   └── (generated)
│   │   ├── package.json
│   │   └── README.md
│   ├── react-cms/               # React SDK (published to npm)
│   │   ├── src/
│   │   │   ├── hooks/
│   │   │   │   ├── useSchemas.ts
│   │   │   │   ├── useEntries.ts
│   │   │   │   └── useSchemaEditor.ts
│   │   │   ├── components/
│   │   │   │   ├── SchemaEditor.tsx
│   │   │   │   ├── SchemaList.tsx
│   │   │   │   ├── EntryForm.tsx
│   │   │   │   └── EntryList.tsx
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── ui-cms/                  # Optional: shadcn/ui styled components
│       └── src/
├── convex/                      # App-specific convex code
└── package.json                 # Root workspace config
```

### 2.3 React Hooks (`packages/react-cms/src/hooks/`)

#### useSchemas.ts

```typescript
import { useQuery, useMutation } from "convex/react";
import { api } from "@json-data-manager/convex-cms";

export function useListSchemas(limit?: number) {
  return useQuery(api.schemas.listSchemas, { limit });
}

export function useGetSchema(schemaId: string | null) {
  return useQuery(
    api.schemas.getSchema,
    schemaId ? { schemaId: schemaId as Id<"jdm_schemas"> } : "skip"
  );
}

export function useGetSchemaBySlug(slug: string) {
  return useQuery(api.schemas.getSchemaBySlug, { slug });
}

export function useCreateSchema() {
  return useMutation(api.schemas.createSchema);
}

export function useUpdateSchema() {
  return useMutation(api.schemas.updateSchema);
}

export function useDeleteSchema() {
  return useMutation(api.schemas.deleteSchema);
}
```

#### useEntries.ts

```typescript
import { useQuery, useMutation } from "convex/react";
import { api } from "@json-data-manager/convex-cms";

export function useListEntries(schemaId: string | null, limit?: number) {
  return useQuery(
    api.entries.listEntries,
    schemaId ? { schemaId: schemaId as Id<"jdm_schemas">, limit } : "skip"
  );
}

export function useListEntriesPaginated(schemaId: string, pageSize: number) {
  const [cursor, setCursor] = useState<string | null>(null);

  const result = useQuery(
    api.entries.listEntriesPaginated,
    { schemaId: schemaId as Id<"jdm_schemas">, pageSize, cursor }
  );

  return {
    ...result,
    nextPage: () => setCursor(result?.page?.nextCursor || null),
    reset: () => setCursor(null),
  };
}

export function useCreateEntry() {
  return useMutation(api.entries.createEntry);
}

export function useCreateBulkEntries() {
  return useMutation(api.entries.createBulkEntries);
}

export function useUpdateEntry() {
  return useMutation(api.entries.updateEntry);
}

export function useDeleteEntry() {
  return useMutation(api.entries.deleteEntry);
}
```

### 2.4 Headless Components

These components handle logic but not styling - consumers bring their own UI.

#### SchemaEditor (Headless)

```typescript
interface SchemaEditorProps {
  initialSchema?: string;
  onSave: (schema: SchemaInput) => Promise<void>;
  render: (props: {
    schemaJson: string;
    setSchemaJson: (json: string) => void;
    isValid: boolean;
    errors: string[];
    isOverLimit: boolean;
    bytesUsed: number;
    onSave: () => void;
  }) => React.ReactNode;
}

export function SchemaEditor({ initialSchema, onSave, render }: SchemaEditorProps) {
  const [schemaJson, setSchemaJson] = useState(initialSchema || "");
  const [isSaving, setIsSaving] = useState(false);

  // Validation logic from existing schema-editor.tsx
  const validation = useMemo(() => validateSchema(schemaJson), [schemaJson]);

  const handleSave = async () => {
    if (!validation.isValid) return;
    setIsSaving(true);
    try {
      const parsed = JSON.parse(schemaJson);
      await onSave({
        title: parsed.title,
        description: parsed.description,
        schema: parsed,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return render({
    schemaJson,
    setSchemaJson,
    ...validation,
    onSave: handleSave,
  });
}
```

#### EntryForm (Headless)

```typescript
interface EntryFormProps {
  schema: unknown;  // JSON Schema
  initialData?: unknown;
  onSubmit: (data: unknown) => Promise<void>;
  validator?: Validator;  // AJV8 or custom
  render: (props: {
    formData: unknown;
    setFormData: (data: unknown) => void;
    errors: ValidationError[];
    isValid: boolean;
    onSubmit: () => void;
  }) => React.ReactNode;
}

export function EntryForm({ schema, initialData, onSubmit, render }: EntryFormProps) {
  // Uses @rjsf/core under the hood but allows consumer to render
  // ...implementation
}
```

### 2.5 Pre-built Styled Components (Optional)

For users who want drop-in components with shadcn/ui styling:

```typescript
// packages/ui-cms/src/SchemaEditor.tsx
// Re-exports the headless component with default shadcn/ui rendering

export function StyledSchemaEditor(props: Omit<SchemaEditorProps, 'render'>) {
  return (
    <SchemaEditor
      {...props}
      render={({ schemaJson, setSchemaJson, isValid, errors, onSave }) => (
        // Pre-built UI using shadcn components
        <div className="space-y-4">
          <JsonEditor value={schemaJson} onChange={setSchemaJson} />
          {!isValid && <ErrorList errors={errors} />}
          <Button onClick={onSave} disabled={!isValid}>Save</Button>
        </div>
      )}
    />
  );
}
```

---

## Part 3: Installation Guide for Consumers

### 3.1 Backend Setup

```bash
npm install @json-data-manager/convex-cms
```

**In `convex/schema.ts`:**
```typescript
import { defineSchema } from "convex/server";
import cmsSchema from "@json-data-manager/convex-cms/schema";

export default defineSchema({
  ...cmsSchema,
  // ... app-specific tables
});
```

**In `convex/index.ts` (re-export for convenience):**
```typescript
// Re-export all component functions
export * from "@json-data-manager/convex-cms";
```

### 3.2 Frontend Setup

```bash
npm install @json-data-manager/react-cms
```

**Basic usage:**
```typescript
import {
  useListSchemas,
  useCreateSchema,
  SchemaEditor
} from "@json-data-manager/react-cms";

function MyCMSPage() {
  const schemas = useListSchemas();
  const createSchema = useCreateSchema();

  return (
    <SchemaEditor
      onSave={async (schema) => {
        await createSchema(schema);
      }}
      render={({ schemaJson, setSchemaJson, onSave }) => (
        // Your UI here
      )}
    />
  );
}
```

---

## Part 4: Implementation Phases

### Phase 1: Backend Component (Week 1)

1. Create `convex/component/` directory structure
2. Copy existing schemas.ts and entries.ts to component
3. Namespace tables (jdm_schemas, jdm_entries)
4. Add pagination and slug support
5. Add proper TypeScript exports
6. Test component in isolation

### Phase 2: Extract React Hooks (Week 2)

1. Set up monorepo with pnpm workspaces
2. Create `packages/react-cms/`
3. Extract hooks from existing routes
4. Package and publish to npm

### Phase 3: Component Library (Week 3)

1. Create headless SchemaEditor component
2. Create headless EntryForm component
3. Create useValidation hook for client-side AJV
4. Document component APIs

### Phase 4: Styled Components (Week 4)

1. Create `packages/ui-cms/` with shadcn/ui dependencies
2. Build pre-styled SchemaEditor
3. Build pre-styled EntryList and EntryForm
4. Create example templates (dashboard, detail views)

### Phase 5: Documentation & Examples (Week 5)

1. Write comprehensive README
2. Create minimal example app
3. Create full-featured demo
4. Write integration guides for Next.js, Vite, etc.

---

## Part 5: Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Table prefix | `jdm_` | Avoids collisions, clearly identifies component tables |
| Pagination | Cursor-based | Scales to large datasets, Convex best practice |
| Slug support | Required with auto-generation | Human-friendly URLs, CMS expectation |
| Entry updates | Supported | Unlike current app, component should be full CRUD |
| Component styling | Headless + optional styled | Maximum flexibility for consumers |
| React version | 18+ (hooks) | Use modern patterns, consumer likely on 18+ |
| Dependencies | Minimal | Only convex, react; @rjsf as peer dependency |

---

## Part 6: Migration Path

For migrating the existing app to use the component:

1. Install component package
2. Update `convex/schema.ts` to include component tables
3. Migrate existing data:
   ```typescript
   // One-time migration script
   const oldSchemas = await ctx.db.query("schemas").collect();
   for (const s of oldSchemas) {
     await ctx.db.insert("jdm_schemas", {
       title: s.title,
       description: s.description,
       schema: s.schema,
       slug: generateSlug(s.title),
       metadata: {},
     });
   }
   ```
4. Update routes to use new hooks
5. Remove old table definitions once migrated
