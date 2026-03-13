# Task: Configure TypeScript

## Description

Set up TypeScript configuration for bundling the library source code while properly handling Convex's raw TypeScript files.

## Requirements

1. Create `tsconfig.json` at the project root with the following characteristics:
   - **Target**: ES2022 for modern JavaScript features
   - **Module**: ESNext with Bundler module resolution
   - **Output**: Declaration files (.d.ts) for library consumers
   - **Source**: Compile `src/` directory to `dist/`
   - **Exclude**: `convex/` directory (Convex CLI handles its own TypeScript compilation)

2. Key configuration points:
   - Enable strict type checking
   - Generate declaration maps for better IDE support
   - Skip library type checking for faster builds
   - Resolve JSON modules for package.json imports

## Complete tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "convex"]
}
```

## Notes

- The `convex/` directory must be excluded because Convex uses its own CLI to compile TypeScript files with a custom runtime environment
- Declaration output is essential for consumers to have proper type inference when importing the library
- Bundler module resolution is required for compatibility with modern build tools like Vite, Rollup, and esbuild
