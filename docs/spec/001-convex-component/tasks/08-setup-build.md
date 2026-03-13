# Task 08: Setup Build Pipeline

## Objective
Configure the build pipeline for the Convex component package to compile TypeScript from `src/` to `dist/` and prepare for npm publishing.

## Steps

### 1. Install Build Dependencies

```bash
bun add -d typescript tsc-alias
```

- `typescript` - TypeScript compiler
- `tsc-alias` - Resolves path aliases (e.g., `@/`, `#/`) after compilation

### 2. Configure TypeScript for Build

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-cms/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": false,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "example"]
}
```

### 3. Add Build Scripts to package.json

Edit `/Users/cadenyoung/Developer/json-data-manager/packages/json-cms/package.json`:

```json
{
  "scripts": {
    "build": "bunx tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    "clean": "rm -rf dist",
    "prepublishOnly": "bun run clean && bun run build"
  }
}
```

### 4. Create .npmignore

Create `/Users/cadenyoung/Developer/json-data-manager/packages/json-cms/.npmignore`:

```
# Source and dev files
src/
example/
tests/
*.test.ts
*.spec.ts

# Config files
tsconfig.json
tsconfig.build.json
.eslintrc.js
.prettierrc
.gitignore

# Build tools
tsc-alias

# IDE
.vscode/
.idea/

# Misc
*.log
.DS_Store
```

### 5. Update package.json Entry Points

Ensure `/Users/cadenyoung/Developer/json-data-manager/packages/json-cms/package.json` has correct entry points:

```json
{
  "name": "@convex-dev/json-cms",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./convex.config.js": "./convex.config.js"
  },
  "files": [
    "dist",
    "convex.config.js",
    "README.md",
    "LICENSE"
  ]
}
```

### 6. Test Local Build

```bash
cd /Users/cadenyoung/Developer/json-data-manager/packages/json-cms
bun run build
```

Verify:
- `dist/` directory is created
- `.js`, `.d.ts`, and `.d.ts.map` files are present
- Path aliases are resolved (no `@/` or `#/` imports in output)

### 7. Publishing Checklist

Before publishing to npm:

- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated with version notes
- [ ] `bun run build` succeeds without errors
- [ ] `bun pm pack --dry-run` shows correct files (no `example/`, no `src/`)
- [ ] README.md has correct install instructions
- [ ] `convex.config.js` is included in `files` array
- [ ] `.npmignore` excludes `example/` directory
- [ ] Login to npm: `npm login`
- [ ] Publish: `npm publish --access public`

### 8. Verify Package Contents

Dry run before actual publish:

```bash
cd /Users/cadenyoung/Developer/json-data-manager/packages/json-cms
bun pm pack --dry-run
```

Expected output should NOT include:
- `example/`
- `src/`
- `tsconfig*.json`

Expected output SHOULD include:
- `dist/`
- `convex.config.js`
- `README.md`
- `package.json`

## Acceptance Criteria

- [ ] `bun run build` compiles TypeScript to `dist/` with declarations
- [ ] `bun run prepublishOnly` runs clean build before publish
- [ ] `.npmignore` excludes `example/` and source files
- [ ] `bun pm pack --dry-run` shows correct package contents
