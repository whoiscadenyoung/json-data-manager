/**
 * Shared helpers for the worktree + dev orchestration scripts.
 *
 * All state lives under `<main repo>/.worktrees/` (gitignored):
 *   .worktrees/<slug>/   git worktrees
 *   .worktrees/registry.json   port slots + worktree metadata
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type Ports = { cloud: number; site: number; vite: number };

export type WorktreeEntry = {
  slug: string;
  branch: string;
  path: string;
  storage: "share" | "fork";
  slot: number;
  vitePort: number;
  convexPorts: { cloud: number; site: number } | null;
  portlessAlias: string | null;
  createdAt: string;
};

export type Registry = {
  version: 1;
  main: {
    path: string;
    branch: string;
    ports: { cloud: number; site: number; vite: number };
  };
  worktrees: WorktreeEntry[];
};

export const PORTLESS_PREFIX = "jdm-";
export const MAIN_PORTS: Ports = { cloud: 3212, site: 3213, vite: 5173 };
export const SLOT_CLOUD_BASE = 3220;
export const SLOT_VITE_BASE = 5180;
export const SLOT_STRIDE = 10;

type ConvexConfig = {
  ports: { cloud: number; site: number };
  backendVersion: string;
  adminKey: string;
  instanceSecret: string;
  cloudProjectId: number;
  deploymentName: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isConvexConfig(value: unknown): value is ConvexConfig {
  if (!isRecord(value)) {
    return false;
  }
  const ports = value["ports"];
  return (
    isRecord(ports) &&
    typeof ports["cloud"] === "number" &&
    typeof ports["site"] === "number" &&
    typeof value["deploymentName"] === "string"
  );
}

function isRegistry(value: unknown): value is Registry {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    !isRecord(value["main"]) ||
    !Array.isArray(value["worktrees"])
  ) {
    return false;
  }
  const main = value["main"];
  return isRecord(main["ports"]);
}

export function git(args: string[], opts?: { cwd?: string }): string {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: opts === undefined ? undefined : opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const err = proc.stderr.toString().trim();
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return proc.stdout.toString().trim();
}

export function gitQuiet(args: string[], opts?: { cwd?: string }): boolean {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: opts === undefined ? undefined : opts.cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

export type Checkout = {
  mainRoot: string;
  checkoutRoot: string;
  isWorktree: boolean;
  slug: string | null;
};

/** Resolve the current checkout: main repo root, and if inside a worktree, its slug. */
export function resolveCheckout(cwd: string = process.cwd()): Checkout {
  const checkoutRoot = resolve(git(["rev-parse", "--show-toplevel"], { cwd }));
  const commonDir = resolve(git(["rev-parse", "--git-common-dir"], { cwd }));
  const mainRoot = dirname(commonDir);
  const isWorktree = checkoutRoot !== mainRoot;
  let slug: string | null = null;
  if (isWorktree) {
    // In a worktree `.git` is a file "gitdir: <main>/.git/worktrees/<name>",
    // and the worktree gitdir basename matches our .worktrees/<slug> layout.
    const gitFile = readFileSync(join(checkoutRoot, ".git"), "utf8");
    const gitdir = gitFile.trim().replace(/^gitdir:\s*/, "");
    slug = basename(gitdir.trim());
  }
  return { mainRoot, checkoutRoot, isWorktree, slug };
}

export function registryPath(mainRoot: string): string {
  return join(mainRoot, ".worktrees", "registry.json");
}

export function loadRegistry(mainRoot: string): Registry {
  const path = registryPath(mainRoot);
  let currentBranch = "main";
  try {
    currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: mainRoot });
  } catch {
    currentBranch = "main";
  }
  if (!existsSync(path)) {
    return {
      version: 1,
      main: { path: mainRoot, branch: currentBranch, ports: { ...MAIN_PORTS } },
      worktrees: [],
    };
  }
  const reg: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRegistry(reg)) {
    throw new Error(
      `Malformed worktree registry at ${path} — delete it and re-run \`bun run worktree add\`.`,
    );
  }
  return reg;
}

export function saveRegistry(mainRoot: string, registry: Registry): void {
  const dir = join(mainRoot, ".worktrees");
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath(mainRoot), JSON.stringify(registry, null, 2) + "\n");
}

export function findEntry(registry: Registry, slug: string): WorktreeEntry | undefined {
  return registry.worktrees.find((entry) => entry.slug === slug);
}

/** Probe whether anything is listening on 127.0.0.1:<port>. */
export async function portOpen(port: number): Promise<boolean> {
  try {
    const conn = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data: () => undefined },
    });
    conn.end();
    return true;
  } catch {
    return false;
  }
}

export async function portFree(port: number): Promise<boolean> {
  return !(await portOpen(port));
}

export function slotPorts(slot: number): { cloud: number; site: number; vite: number } {
  const offset = (slot - 1) * SLOT_STRIDE;
  return {
    cloud: SLOT_CLOUD_BASE + offset,
    site: SLOT_CLOUD_BASE + offset + 1,
    vite: SLOT_VITE_BASE + offset,
  };
}

export function readConvexConfig(appDir: string): ConvexConfig | null {
  const path = convexConfigPath(appDir);
  if (!existsSync(path)) {
    return null;
  }
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isConvexConfig(config) ? config : null;
}

const CONVEX_CONFIG_REL = "local/default/config.json";

export function convexConfigPath(appDir: string): string {
  return join(appDir, ".convex", CONVEX_CONFIG_REL);
}

/** Rewrite the deployment URLs (and keep other keys) in an app-level .env.local. */
export function writeAppEnvLocal(
  appDir: string,
  ports: { cloud: number; site: number },
  deploymentName: string,
): void {
  const path = join(appDir, ".env.local");
  const lines = [
    "# Deployment used by `npx convex dev`",
    `CONVEX_DEPLOYMENT=${deploymentName}`,
    "",
    `VITE_CONVEX_URL=http://127.0.0.1:${ports.cloud}`,
    "",
    `VITE_CONVEX_SITE_URL=http://127.0.0.1:${ports.site}`,
    "",
  ];
  writeFileSync(path, lines.join("\n"));
}

export function patchEnvLocal(content: string, ports: { cloud: number; site: number }): string {
  const replacements: Record<string, string> = {
    VITE_CONVEX_URL: `http://127.0.0.1:${ports.cloud}`,
    VITE_CONVEX_SITE_URL: `http://127.0.0.1:${ports.site}`,
  };
  return content
    .split("\n")
    .map((line) => {
      const eq = line.indexOf("=");
      const key = eq === -1 ? "" : line.slice(0, eq).trim();
      if (key in replacements) {
        return `${key}=${replacements[key]}`;
      }
      return line;
    })
    .join("\n");
}

/** sha256 of a file, for bun.lock drift detection. */
export function hashFile(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
}

/** All node_modules directories (as repo-relative paths) that exist in the main checkout. */
export function nodeModuleDirs(mainRoot: string): string[] {
  const found: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    if (rel === undefined) {
      break;
    }
    const abs = rel === "" ? mainRoot : join(mainRoot, rel);
    const scan = scanDir(abs, rel);
    found.push(...scan.nodeModules);
    stack.push(...scan.childDirs);
  }
  return found.toSorted();
}

const WALK_SKIP = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  ".convex",
  ".output",
  "dist",
  "dist-ssr",
  ".tanstack",
  ".nitro",
]);

/** One directory scan: node_modules found here + child dirs worth walking. */
function scanDir(abs: string, rel: string): { childDirs: string[]; nodeModules: string[] } {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return { childDirs: [], nodeModules: [] };
  }
  const childDirs: string[] = [];
  const nodeModules: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = rel === "" ? entry.name : join(rel, entry.name);
    if (entry.name === "node_modules") {
      nodeModules.push(path);
      continue;
    }
    if (!WALK_SKIP.has(entry.name) && !entry.name.startsWith(".")) {
      childDirs.push(path);
    }
  }
  return { childDirs, nodeModules };
}

/** Relative symlink target from `<worktree>/<relDir>` back to the main checkout's same dir. */
export function symlinkTarget(mainRoot: string, worktreePath: string, relDir: string): string {
  const linkAbs = join(worktreePath, relDir);
  const targetAbs = join(mainRoot, relDir);
  const rel = relative(dirname(linkAbs), targetAbs);
  return rel === "" ? "." : rel;
}

export function createSymlink(linkPath: string, target: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(linkPath);
    } else {
      throw new Error(`${linkPath} exists and is not a symlink; remove it first`);
    }
  }
  symlinkSync(target, linkPath, "dir");
}

export function copyDirIfMissing(srcAbs: string, destAbs: string): boolean {
  if (!existsSync(srcAbs) || existsSync(destAbs)) {
    return false;
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  cpSync(srcAbs, destAbs, { recursive: true });
  return true;
}

export function portless(): string | null {
  return Bun.which("portless");
}

export async function portlessAlias(alias: string, port: number): Promise<boolean> {
  const bin = portless();
  if (bin === null) {
    return false;
  }
  const proc = Bun.spawnSync({
    cmd: [bin, "alias", alias, String(port)],
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

export function portlessRemove(alias: string): boolean {
  const bin = portless();
  if (bin === null) {
    return false;
  }
  const proc = Bun.spawnSync({
    cmd: [bin, "alias", "--remove", alias],
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exitCode === 0;
}

export function mainBranch(registry: Registry): string {
  return registry.main.branch || "main";
}
