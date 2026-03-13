# System Architecture Guide

## Overview

A JSON data management application built with React, Convex (backend/database), and TanStack Router. The system enables users to define JSON schemas and create/manage data entries that conform to those schemas.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript |
| Routing | TanStack Router (file-based) |
| Data Fetching | Convex React SDK + TanStack Query |
| Backend/DB | Convex (serverless) |
| UI Components | shadcn/ui, Base UI |
| Forms | @rjsf/shadcn (schema-based), TanStack Form |
| Styling | Tailwind CSS v4 |
| Validation | AJV8 (via @rjsf/validator-ajv8) |

---

## Database Schema

Convex tables defined in `convex/schema.ts`:

### `schemas` Table

```typescript
{
  title: string;           // Display name
  description: string;     // Human-readable description
  schema: any;             // JSON Schema Draft-07 object
}
```

Stores JSON schema definitions that describe the structure of data entries.

### `entries` Table

```typescript
{
  schemaId: Id<"schemas">; // Foreign key to schemas table
  data: any;               // Entry data conforming to the schema
}
// Index: by_schema (for efficient schema-based queries)
```

Stores actual data entries. Each entry references a schema and stores arbitrary JSON data validated against that schema.

---

## Backend Functions (Convex)

### Schema Management (`convex/schemas.ts`)

| Function | Type | Description |
|----------|------|-------------|
| `list` | query | Returns all schemas ordered by creation time (desc) |
| `get` | query | Retrieves a single schema by ID; throws if not found |
| `create` | mutation | Inserts new schema; validates `title` and `description` required; enforces 100KB size limit |
| `update` | mutation | Patches schema fields; full schema updates only allowed when no entries exist (to preserve data integrity); metadata-only updates allowed otherwise |

### Entry Management (`convex/entries.ts`)

| Function | Type | Description |
|----------|------|-------------|
| `list` | query | Returns all entries for a given schema ID (uses `by_schema` index) |
| `get` | query | Retrieves single entry by ID |
| `create` | mutation | Inserts single entry; verifies schema exists |
| `createBulk` | mutation | Batch inserts multiple entries; single transaction |

### Key Backend Patterns

- **Validation**: Schema size limit (100KB) enforced server-side
- **Referential Integrity**: Entry mutations verify schema existence before insert
- **Indexing**: `by_schema` index on `entries` for efficient per-schema queries
- **Error Handling**: Uses `ConvexError` for typed error messages

---

## Frontend Architecture

### Routing Structure (TanStack Router)

File-based routing in `src/routes/`:

```
/__root.tsx              # Root layout with providers
/index.tsx               # Landing page
/schemas/
  /index.tsx             # Schema list (dashboard)
  /create.tsx            # Create new schema
  /$schemaId/
    /index.tsx           # Schema detail + entries list
    /edit.tsx            # Edit schema (metadata or full)
    /create.tsx          # Create single entry (form-based)
    /bulk-upload.tsx     # Bulk upload entries (JSON array)
    /$entryId.tsx        # Entry detail view
```

### Data Flow Pattern

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   React UI  │────▶│ Convex Hooks │────▶│  Convex Server  │
│             │◀────│ (useQuery/   │◀────│  (queries/      │
│             │     │  useMutation)│     │   mutations)    │
└─────────────┘     └──────────────┘     └─────────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ TanStack     │
                    │ QueryClient  │
                    └──────────────┘
```

### Convex Integration

**Provider** (`src/integrations/convex/provider.tsx`):
```typescript
const convexQueryClient = new ConvexQueryClient(env.VITE_CONVEX_URL);
<ConvexProvider client={convexQueryClient.convexClient}>
```

**Usage in Components**:
```typescript
// Queries
const schemas = useQuery(api.schemas.list);
const schema = useQuery(api.schemas.get, { schemaId });
const entries = useQuery(api.entries.list, { schemaId });

// Mutations
const createSchema = useMutation(api.schemas.create);
const createEntry = useMutation(api.entries.create);
const createBulk = useMutation(api.entries.createBulk);
```

---

## Key Frontend Components

### Schema Editor (`src/components/schema-editor/schema-editor.tsx`)

Dual-mode JSON schema editor:

- **Visual Mode**: Form-based builder for common schema properties
- **Code Mode**: Raw JSON editor with CodeMirror
- **Validation Pane**: Side panel for testing schema against sample data
- **Drag & Drop**: Accepts JSON files (schema objects or data arrays)
- **Schema Inference**: Auto-generates schema from data arrays

### Entry Creation Flow

**Single Entry** (`/schemas/$schemaId/create.tsx`):
```typescript
// Uses @rjsf/shadcn to render dynamic form from JSON schema
<Form schema={schema.schema} validator={validator} onSubmit={handleSubmit} />
```

**Bulk Upload** (`/schemas/$schemaId/bulk-upload.tsx`):
1. Accepts JSON array via file upload or paste
2. Client-side validation against schema using AJV8
3. Displays per-entry validation results
4. Submits only valid entries via `createBulk` mutation

### Schema Edit Protection

When a schema has entries, editing is restricted to metadata only (`title`, `description`). This preserves data integrity by preventing structural changes that would invalidate existing entries.

```typescript
// In edit.tsx
const hasEntries = entries.length > 0;
hasEntries 
  ? <MetadataEditForm />   // Title/description only
  : <FullSchemaEditForm /> // Full schema editor
```

---

## Utilities

### Schema Inference (`src/lib/infer-schema.ts`)

Infers JSON Schema Draft-07 from an array of plain objects:

- Type inference: `string`, `number`, `integer`, `boolean`, `object`, `array`, `null`
- Merged types for heterogeneous data (e.g., `integer` + `number` → `number`)
- Nested object support (recursive inference)
- Required field detection (present in all objects, non-null)

```typescript
export function inferSchemaFromData(data: unknown[]): Record<string, unknown>
```

---

## Data Pipeline Summary

### Creating a Schema

1. User builds schema in SchemaEditor (visual or code mode)
2. Client validates JSON syntax and required fields (`title`, `description`)
3. Client enforces 100KB size limit
4. `createSchema({ schema })` mutation → Convex
5. Convex validates and inserts into `schemas` table
6. User redirected to schema detail page

### Creating an Entry

1. User navigates to schema detail, clicks "Create Entry"
2. `@rjsf/shadcn` renders form from JSON schema
3. User fills form, client validates via AJV8
4. `createEntry({ schemaId, data })` mutation → Convex
5. Convex verifies schema exists, inserts into `entries` table
6. Entry appears in schema's entry list (auto-refreshed via `useQuery`)

### Bulk Upload

1. User provides JSON array (file or paste)
2. Client parses and validates each item against schema
3. Validation results displayed with per-item error details
4. User submits; `createBulk({ schemaId, dataArray })` → Convex
5. Batch insert in single transaction

### Export

1. Schema detail page offers export functionality
2. Downloads two files:
   - `{slug}-schema.json`: The schema definition
   - `{slug}-entries.json`: Array of all entry data

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Schema stored as `any` type | JSON Schemas are self-describing; strict typing would be overly complex |
| No entry update/delete | MVP scope; entries are append-only for simplicity |
| Schema edit restrictions | Prevents data corruption; existing entries must remain valid |
| Client-side validation first | Fast feedback; server validates as secondary defense |
| TanStack Query + Convex | Caching, devtools, and optimistic updates via proven patterns |
| File-based routing | Colocation of routes with components; automatic route tree generation |
