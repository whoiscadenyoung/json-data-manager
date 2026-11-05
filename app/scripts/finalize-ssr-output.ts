/**
 * Finalizes the prod SSR output for the self-contained image, then verifies
 * it (#243).
 *
 * react stays EXTERNAL through the whole prod server pipeline
 * (vite.config.ts — the SSR service env externalizes node_modules by
 * default; the nitro env is pinned via nitro.rolldownConfig.external) so a
 * process has exactly ONE react instance: the real packages. This script
 *
 * 1. materializes react / react-dom / scheduler into
 *    `.output/server/node_modules/` — the runtime image ships `.output`
 *    alone (Dockerfile), and both of rolldown's interop flavors for an
 *    external react (an ESM `import "react"` or a bare `__require("react")`
 *    CJS shim — the flavor differs per platform build, which is what burned
 *    the linux container in #243) resolve against these real packages.
 *
 * 2. verifies self-containment: every bare-specifier reference in the
 *    output (`__require("<pkg>")`, dynamic `import("<pkg>")`, static
 *    imports) must be a node builtin or live inside
 *    `.output/server/node_modules/`. The #243 failure — a bare
 *    `__require("react")` with nothing shipped to answer it, so every route
 *    served ResolveMessage JSON — fails the build here instead of at first
 *    render.
 *
 * Wired into `bun run build` after `vite build`; CI and the Dockerfile
 * build both inherit the guarantee.
 */

import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";

const appDir = dirname(import.meta.dir);
const serverDir = join(appDir, ".output", "server");

/** Runtime packages the SSR output keeps external — kept in sync with vite.config.ts. */
const EXTERNAL_RUNTIME_PACKAGES = ["react", "react-dom", "scheduler"];

const BUILTINS = new Set(builtinModules);

/** Package dirs materialized so far this run — later externals resolve transitives against them. */
const materializedSources: string[] = [];

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (BUILTINS.has(specifier)) return true;
  return BUILTINS.has(specifier.split("/")[0]);
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isShipped(specifier: string): boolean {
  return existsSync(join(serverDir, "node_modules", packageOf(specifier)));
}

function materializeExternals(): void {
  const require = createRequire(join(appDir, "package.json"));
  for (const pkg of EXTERNAL_RUNTIME_PACKAGES) {
    // Resolve through bun's isolated linker (store symlinks) to the real
    // package dir, then copy dereferenced so the output is standalone.
    // Transitive externals (scheduler under react-dom) aren't visible from
    // the app manifest, so fall back to resolving from the real store dirs
    // of the packages already resolved this run — bun installs a store
    // package's deps as siblings of it, so they resolve from there.
    const resolvers = [
      require,
      ...materializedSources.map((dir) => createRequire(join(dir, "package.json"))),
    ];
    let packageJsonPath: string | undefined;
    let resolveError: unknown;
    for (const resolver of resolvers) {
      try {
        packageJsonPath = realpathSync(resolver.resolve(`${pkg}/package.json`));
        break;
      } catch (error) {
        resolveError = error;
      }
    }
    if (typeof packageJsonPath !== "string") {
      throw new Error(
        `finalize-ssr-output: cannot resolve external runtime package "${pkg}": ${
          resolveError instanceof Error ? resolveError.message : String(resolveError)
        }`,
      );
    }
    const source = dirname(packageJsonPath);
    const dest = join(serverDir, "node_modules", pkg);
    cpSync(source, dest, { recursive: true, dereference: true });
    materializedSources.push(source);
    console.log(`finalize-ssr-output: materialized ${pkg} -> ${dest}`);
  }
}

/** [pattern, source] pairs scanned over every chunk. The import() pattern
 * excludes a `{`/identifier right before `import(` so JSDoc typedefs
 * (`{import('hast').Nodes}`) don't count as runtime references. */
const REFERENCE_PATTERNS: Array<[RegExp, string]> = [
  [/__require\s*\(\s*["']([^"']+)["']\s*\)/g, "__require"],
  [/(?<![\w.${}])import\s*\(\s*["']([^"']+)["']\s*\)/g, "import()"],
];
// Static imports are matched line-anchored so JSDoc prose ("import x from
// 'y'" inside a comment) can't false-positive.
const STATIC_FROM_RE = /^\s*(?:import|export)\b.*\bfrom\s*["']([^"']+)["']/;

function isBare(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function collectViolations(): string[] {
  const entries = readdirSync(serverDir, { recursive: true });
  const chunks = entries.filter((entry) => String(entry).endsWith(".mjs"));
  const violations = new Map<string, Set<string>>();
  let scanned = 0;
  for (const entry of chunks) {
    const file = join(serverDir, String(entry));
    if (!statSync(file).isFile()) continue;
    scanned += 1;
    const text = readChunk(file);
    const found: string[] = [];
    for (const [pattern] of REFERENCE_PATTERNS) {
      for (const match of text.matchAll(pattern)) found.push(match[1]);
    }
    for (const line of text.split("\n")) {
      const match = STATIC_FROM_RE.exec(line);
      if (match) found.push(match[1]);
    }
    for (const specifier of found) {
      if (!isBare(specifier)) continue;
      if (isBuiltin(specifier)) continue;
      if (isShipped(specifier)) continue;
      const key = String(entry);
      const set = violations.get(key) ?? new Set<string>();
      set.add(specifier);
      violations.set(key, set);
    }
  }
  console.log(`finalize-ssr-output: scanned ${scanned} server chunks`);
  const lines: string[] = [];
  for (const [file, specs] of violations) {
    for (const spec of specs) {
      lines.push(`${file}: bare external "${spec}" resolves to nothing in the image`);
    }
  }
  return lines;
}

// Read via node:fs — bun implements it natively.
function readChunk(file: string): string {
  return readFileSync(file, "utf8");
}

if (!existsSync(join(serverDir, "index.mjs"))) {
  console.error(`finalize-ssr-output: no SSR output at ${serverDir} — run \`vite build\` first.`);
  process.exit(1);
}

materializeExternals();
const violations = collectViolations();
if (violations.length > 0) {
  console.error(
    [
      "finalize-ssr-output: the SSR output is NOT self-contained (#243 guard):",
      ...violations,
      "",
      "Every bare external must be a node builtin or ship inside",
      ".output/server/node_modules. If a new dependency stayed external, add",
      "it to EXTERNAL_RUNTIME_PACKAGES here and the matching external pattern",
      "in vite.config.ts (nitro.rolldownConfig.external).",
    ].join("\n"),
  );
  process.exit(1);
}
console.log("finalize-ssr-output: SSR output is self-contained ✓");
