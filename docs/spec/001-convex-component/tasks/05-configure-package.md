# Task: Configure Package

## Description

Set up the package.json for the Convex component with proper exports, dependencies, and build configuration.

## Path

`packages/json-cms/`

## Requirements

### Subpath Exports
- `.` - Main entry point for React components and hooks
- `./convex` - Convex functions (queries, mutations, actions)
- `./convex/schema` - Schema definition

### Files Whitelist
Only include these directories in the published package:
- `dist/` - Compiled JavaScript output
- `convex/` - Convex function definitions

### Peer Dependencies
- `convex` - The Convex SDK (required)
- `react` - React for UI components
- `react-dom` - React DOM for UI components

### Dependencies
- `@rjsf/core` - React JSON Schema Form core
- `ajv` - JSON Schema validation

### Build Scripts
- `build` - Compile TypeScript to dist/ using `bunx tsc`
- `typecheck` - Run TypeScript type checking

## Package.json

```json
{
  "name": "@convex-dev/json-cms",
  "version": "0.1.0",
  "description": "Convex component for JSON Data Manager - schema management and data entry",
  "type": "module",
  "files": [
    "dist/",
    "convex/"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./convex": {
      "types": "./dist/convex.d.ts",
      "import": "./dist/convex.js"
    },
    "./convex/schema": {
      "types": "./dist/schema.d.ts",
      "import": "./dist/schema.js"
    }
  },
  "scripts": {
    "build": "bunx tsc",
    "typecheck": "bunx tsc --noEmit"
  },
  "peerDependencies": {
    "convex": "^1.0.0",
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "dependencies": {
    "@rjsf/core": "^5.0.0",
    "ajv": "^8.12.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "typescript": "^5.0.0"
  },
  "license": "MIT"
}
```

## Notes

- The `type: "module"` field enables ES modules by default
- Peer dependencies use loose version ranges to allow flexibility
- React 18 and 19 are both supported (the host app uses React 19)
- The `files` whitelist ensures only necessary files are published
- Each export has both `types` and `import` for proper TypeScript support
- Uses `bunx tsc` for building instead of `tsc` directly
