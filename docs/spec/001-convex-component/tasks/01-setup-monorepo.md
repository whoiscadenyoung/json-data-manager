# Task 01: Setup Monorepo Structure

## Goal
Convert the repository from a single TanStack Start app into a pnpm monorepo with a workspace for the Convex component package.

## Steps

### 1. Create Package Directory Structure

```bash
mkdir -p packages/json-data-manager
```

### 2. Create Root package.json

Create `/Users/cadenyoung/Developer/json-data-manager/package.json`:

```json
{
  "name": "json-data-manager-root",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "pnpm --filter json-data-manager-app dev",
    "build": "pnpm --filter json-data-manager-app build",
    "start": "pnpm --filter json-data-manager-app start",
    "convex:dev": "pnpm --filter json-data-manager convex dev",
    "convex:deploy": "pnpm --filter json-data-manager convex deploy"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

### 3. Create pnpm-workspace.yaml

Create `/Users/cadenyoung/Developer/json-data-manager/pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

### 4. Move Existing App to apps/ Directory

```bash
mkdir -p apps
# Move all existing app files to apps/json-data-manager/
# This includes: src/, convex/, public/, package.json, etc.
```

### 5. Update App package.json

Update `/Users/cadenyoung/Developer/json-data-manager/apps/json-data-manager/package.json`:

```json
{
  "name": "json-data-manager-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vinxi dev",
    "build": "vinxi build",
    "start": "vinxi start"
  },
  "dependencies": {
    "@base-ui/react": "^1.0.0",
    "@codemirror/lang-json": "^6.0.1",
    "@convex-dev/zod": "^0.1.0",
    "@rjsf/core": "^5.24.0",
    "@rjsf/shadcn": "^5.24.0",
    "@rjsf/utils": "^5.24.0",
    "@rjsf/validator-ajv8": "^5.24.0",
    "@tailwindcss/postcss": "^4.0.0",
    "@tanstack/react-form": "^0.41.0",
    "@tanstack/react-router": "^1.95.0",
    "@tanstack/react-start": "^1.95.0",
    "@uiw/react-codemirror": "^4.23.0",
    "ajv": "^8.17.0",
    "convex": "^1.17.0",
    "lucide-react": "^0.469.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^2.6.0",
    "tailwindcss": "^4.0.0",
    "vinxi": "^0.5.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

### 6. Create Component Package Structure

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-data-manager/package.json`:

```json
{
  "name": "@convex-dev/json-data-manager",
  "version": "0.1.0",
  "description": "Convex component for JSON data management with schema validation",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./convex": {
      "import": "./dist/convex/index.js",
      "types": "./dist/convex/index.d.ts"
    }
  },
  "files": [
    "dist",
    "src",
    "convex"
  ],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "convex": "^1.17.0"
  },
  "devDependencies": {
    "convex": "^1.17.0",
    "typescript": "^5.7.0"
  }
}
```

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-data-manager/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 7. Create Initial Source Files

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-data-manager/src/index.ts`:

```typescript
// Main entry point for the component
export { defineJsonDataManager } from './component.js';
export type { JsonDataManagerConfig, JsonDataManagerAPI } from './types.js';
```

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-data-manager/src/types.ts`:

```typescript
import type { DataModelFromSchemaDefinition } from 'convex/server';
import type { JsonDataManagerSchema } from './schema.js';

export interface JsonDataManagerConfig {
  maxSchemaSizeBytes?: number;
  maxEntrySizeBytes?: number;
  maxEntriesPerSchema?: number;
}

export type JsonDataManagerDataModel = DataModelFromSchemaDefinition<
  typeof JsonDataManagerSchema
>;

export interface JsonDataManagerAPI {
  schemas: {
    create: (args: { title: string; description?: string; schema: object }) => Promise<string>;
    get: (args: { id: string }) => Promise<{ _id: string; title: string; description?: string; schema: object } | null>;
    list: () => Promise<Array<{ _id: string; title: string; description?: string; schema: object }>>;
    update: (args: { id: string; title?: string; description?: string; schema?: object }) => Promise<void>;
    remove: (args: { id: string }) => Promise<void>;
  };
  entries: {
    create: (args: { schemaId: string; data: object }) => Promise<string>;
    get: (args: { id: string }) => Promise<{ _id: string; schemaId: string; data: object } | null>;
    listBySchema: (args: { schemaId: string }) => Promise<Array<{ _id: string; schemaId: string; data: object }>>;
    update: (args: { id: string; data: object }) => Promise<void>;
    remove: (args: { id: string }) => Promise<void>;
  };
}
```

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-data-manager/src/schema.ts`:

```typescript
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const JsonDataManagerSchema = defineSchema({
  schemas: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    schema: v.any(),
    sizeBytes: v.number(),
  })
    .index('by_title', ['title'])
    .index('by_size', ['sizeBytes']),

  entries: defineTable({
    schemaId: v.id('schemas'),
    data: v.any(),
    sizeBytes: v.number(),
  })
    .index('by_schema', ['schemaId'])
    .index('by_schema_size', ['schemaId', 'sizeBytes']),
});
```

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-data-manager/src/component.ts`:

```typescript
import { defineComponent } from 'convex/server';
import { JsonDataManagerSchema } from './schema.js';
import type { JsonDataManagerConfig } from './types.js';

export function defineJsonDataManager(config: JsonDataManagerConfig = {}) {
  return defineComponent('jsonDataManager', {
    schema: JsonDataManagerSchema,
    args: {
      maxSchemaSizeBytes: config.maxSchemaSizeBytes ?? 100 * 1024, // 100KB
      maxEntrySizeBytes: config.maxEntrySizeBytes ?? 100 * 1024, // 100KB
      maxEntriesPerSchema: config.maxEntriesPerSchema ?? 10000,
    },
  });
}
```

### 8. Update Root CLAUDE.md

Add to `/Users/cadenyoung/Developer/json-data-manager/CLAUDE.md`:

```markdown
## Monorepo Structure

This is a pnpm monorepo with the following structure:

```
/
├── apps/
│   └── json-data-manager/     # TanStack Start application (moved from root)
├── packages/
│   └── json-data-manager/     # Convex component package
│       ├── src/
│       │   ├── index.ts       # Main exports
│       │   ├── types.ts       # TypeScript types
│       │   ├── schema.ts      # Convex schema definition
│       │   └── component.ts   # Component factory
│       └── convex/            # Convex functions (to be added)
├── docs/
│   └── spec/
│       └── 001-convex-component/  # Implementation plan
└── package.json               # Root workspace config
```

### Workspaces

- `apps/*` - Applications (TanStack Start, etc.)
- `packages/*` - Published packages (Convex components, shared libraries)

### Commands

```bash
# Install all dependencies
pnpm install

# Run app dev server
pnpm dev

# Build component package
pnpm --filter @convex-dev/json-data-manager build

# Type check component
pnpm --filter @convex-dev/json-data-manager typecheck
```
```

## Verification

After completing these steps:

1. Run `pnpm install` to install dependencies
2. Verify `pnpm-workspace.yaml` is recognized: `pnpm workspaces list`
3. Check that the app still starts: `pnpm dev`
4. Verify component package builds: `pnpm --filter @convex-dev/json-data-manager typecheck`

## Dependencies

None - this is the first task.

## Next Steps

- Task 02: Implement Convex schema and mutations in the component package
