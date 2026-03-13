# Task 09: Write Documentation

## Overview
Create comprehensive documentation for the `@convex-dev/json-cms` component, including installation instructions, API reference, usage examples, and migration guide.

## Documentation Outline

### 1. README.md

#### Installation
- bun installation commands
- Convex project setup requirements
- Required peer dependencies
- Environment variable configuration

#### Quick Start
- Minimal setup example
- First schema creation
- First data entry

#### Features Overview
- JSON Schema validation
- Auto-generated forms
- Real-time data sync
- Type-safe hooks

---

### 2. API Reference

#### Hooks

**`useSchemas()`**
- Returns: List of all schemas with metadata
- Type: `QueryReturnType<typeof api.schemas.list>`
- Usage: Display schema list, schema selector dropdowns

**`useSchema(schemaId: string)`**
- Returns: Single schema by ID
- Type: `QueryReturnType<typeof api.schemas.get>`
- Usage: Schema detail views, editing forms

**`useEntries(schemaId: string, opts?: PaginationOpts)`**
- Returns: Paginated entries for a schema
- Type: `QueryReturnType<typeof api.entries.list>`
- Options: `cursor`, `limit`, `order`
- Usage: Data tables, entry lists

**`useEntry(entryId: string)`**
- Returns: Single entry with resolved schema
- Type: `QueryReturnType<typeof api.entries.get>`
- Usage: Entry detail views, editing

**`useCreateSchema()`**
- Returns: Mutation function
- Args: `{ title, description?, schema }`
- Validation: 100KB size limit enforced
- Usage: Schema creation forms

**`useUpdateSchema()`**
- Returns: Mutation function
- Args: `{ id, title?, description?, schema? }`
- Validation: 100KB size limit, prevents edit if entries exist
- Usage: Schema editing (no-entries mode only)

**`useDeleteSchema()`**
- Returns: Mutation function
- Args: `id: string`
- Behavior: Cascading delete of all associated entries
- Usage: Schema deletion with confirmation

**`useCreateEntry()`**
- Returns: Mutation function
- Args: `{ schemaId, data }`
- Validation: Against schema's JSON Schema
- Usage: Data entry forms

**`useUpdateEntry()`**
- Returns: Mutation function
- Args: `{ id, data }`
- Validation: Against schema's JSON Schema
- Usage: Entry editing

**`useDeleteEntry()`**
- Returns: Mutation function
- Args: `id: string`
- Usage: Entry deletion

**`useValidateData(schema: object)`**
- Returns: `{ validate, errors }`
- validate: `(data: unknown) => boolean`
- errors: `RJSFValidationError[]`
- Usage: Client-side validation before submission

#### Components

**`<SchemaEditor />`**
- Props:
  - `initialSchema?: Schema` - Load existing schema for editing
  - `onSave: (schema: SchemaInput) => void` - Save callback
  - `readOnly?: boolean` - Disable editing
  - `mode: 'create' | 'edit'` - Editor mode
- Features: Visual builder, JSON editor, validation pane

**`<SchemaForm />`**
- Props:
  - `schema: object` - JSON Schema
  - `data?: unknown` - Initial form data
  - `onSubmit: (data: unknown) => void` - Submit handler
  - `liveValidate?: boolean` - Validate on change
- Returns: RJSF-powered auto-generated form

**`<EntryTable />`**
- Props:
  - `schemaId: string` - Schema to display entries for
  - `columns?: string[]` - Specific properties to display
  - `onRowClick?: (entry: Entry) => void` - Row click handler
- Features: Pagination, sorting, real-time updates

**`<JSONEditor />`**
- Props:
  - `value: string` - JSON string
  - `onChange: (value: string) => void` - Change handler
  - `height?: string` - Editor height (default: '256px')
  - `readOnly?: boolean` - Disable editing
- Features: Syntax highlighting, error detection

---

### 3. Usage Examples

#### Example 1: Basic Schema Management
```typescript
// List all schemas
function SchemaList() {
  const schemas = useSchemas();
  const deleteSchema = useDeleteSchema();

  return (
    <ul>
      {schemas?.map(schema => (
        <li key={schema._id}>
          {schema.title}
          <button onClick={() => deleteSchema(schema._id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

#### Example 2: Creating a Schema
```typescript
function CreateSchemaPage() {
  const createSchema = useCreateSchema();

  const handleSave = async (schemaData: SchemaInput) => {
    await createSchema(schemaData);
    navigate('/schemas');
  };

  return <SchemaEditor mode="create" onSave={handleSave} />;
}
```

#### Example 3: Data Entry with Validation
```typescript
function CreateEntryPage({ schemaId }: { schemaId: string }) {
  const schema = useSchema(schemaId);
  const createEntry = useCreateEntry();

  if (!schema) return <Loading />;

  return (
    <SchemaForm
      schema={schema.schema}
      onSubmit={(data) => createEntry({ schemaId, data })}
      liveValidate
    />
  );
}
```

#### Example 4: Real-time Entry List
```typescript
function EntryList({ schemaId }: { schemaId: string }) {
  const { entries, loadMore, hasMore } = useEntries(schemaId, { limit: 50 });

  return (
    <>
      <table>
        {entries.map(entry => (
          <tr key={entry._id}>
            <td>{JSON.stringify(entry.data)}</td>
          </tr>
        ))}
      </table>
      {hasMore && <button onClick={loadMore}>Load More</button>}
    </>
  );
}
```

#### Example 5: Client-side Validation
```typescript
function ValidationExample() {
  const jsonSchema = { type: 'object', properties: { email: { type: 'string' } } };
  const { validate, errors } = useValidateData(jsonSchema);

  const handleCheck = (data: unknown) => {
    const isValid = validate(data);
    if (!isValid) {
      console.log('Validation errors:', errors);
    }
  };

  return <button onClick={() => handleCheck({ email: 'invalid' })}>Validate</button>;
}
```

---

### 4. Migration Guide

#### From Existing JSON Data Manager App

**Step 1: Install the Component**
```bash
bun add @convex-dev/json-cms
```

**Step 2: Update Convex Configuration**
- Remove old `schemas.ts` and `entries.ts` from `convex/`
- Add component configuration to `convex.json`:
```json
{
  "components": {
    "jsonCms": "@convex-dev/json-cms"
  }
}
```

**Step 3: Update Imports**
```typescript
// Before
import { api } from '../../convex/_generated/api';

// After
import { api } from '@convex-dev/json-cms/api';
```

**Step 4: Migrate Data (if needed)**
- Export existing schemas and entries
- Transform to component format (IDs remain compatible)
- Import using component mutations

**Step 5: Replace Components**
```typescript
// Before
import { SchemaEditor } from '@/components/schema-editor/schema-editor';

// After
import { SchemaEditor } from '@convex-dev/json-cms/components';
```

**Breaking Changes:**
- Hook names may differ (check API reference)
- Component props may have changed
- Mutation return types may differ

**Migration Checklist:**
- [ ] Install component package
- [ ] Update Convex configuration
- [ ] Replace all API imports
- [ ] Update component imports
- [ ] Test all CRUD operations
- [ ] Verify real-time updates work
- [ ] Check validation behavior

---

## Acceptance Criteria

- [ ] README.md created with installation and quick start
- [ ] API reference documents all hooks with types and examples
- [ ] API reference documents all components with props
- [ ] At least 5 usage examples covering common scenarios
- [ ] Migration guide from existing app structure
- [ ] All code examples are copy-paste ready
- [ ] Documentation is linked from main project README

## Dependencies
- Component implementation complete (Tasks 01-08)
- Final API surface is stable

## Estimated Effort
Medium - 2-3 hours
