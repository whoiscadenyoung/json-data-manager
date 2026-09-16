/**
 * Worktree management for isolated dev checkouts.
 *
 *   bun run worktree add <slug> [branch] [--fork]   create worktree + share env/deps/ports
 *   bun run worktree list                           status of all worktrees
 *   bun run worktree remove <slug> [--force] [--delete-branch]
 *   bun run worktree clean [--dry-run] [--force] [--delete-branches] [--quiet]
 *   bun run worktree ports                          show the port map
 *
 * See docs/dev-environment.md for the full setup and workflow.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Registry,
  type WorktreeEntry,
  PORTLESS_PREFIX,
  copyDirIfMissing,
  createSymlink,
  findEntry,
  git,
  gitQuiet,
  hashFile,
  loadRegistry,
  mainBranch,
  nodeModuleDirs,
  patchEnvLocal,
  portFree,
  portlessAlias,
  portlessRemove,
  readConvexConfig,
  resolveCheckout,
  saveRegistry,
  slotPorts,
  symlinkTarget,
  writeAppEnvLocal,
} from "./lib.ts";

type Flags = {
  force: boolean;
  dryRun: boolean;
  deleteBranches: boolean;
  quiet: boolean;
  fork: boolean;
};

function parseFlags(args: string[]): Flags {
  const deleteBranches = args.includes("--delete-branches") || args.includes("--delete-branch");
  return {
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    deleteBranches,
    quiet: args.includes("--quiet"),
    fork: args.includes("--fork"),
  };
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function usage(message: string): never {
  if (message !== "") {
    console.error(`Error: ${message}`);
  }
  console.error("Usage: bun run worktree <add|list|remove|clean|ports> [args] [--flags]");
  console.error("  add <slug> [branch] [--fork]    create + wire a worktree (.worktrees/<slug>)");
  console.error("  list                            show worktree status");
  console.error("  remove <slug> [--force] [--delete-branch]");
  console.error(
    "  clean [--dry-run] [--force] [--delete-branches] [--quiet]  remove merged worktrees",
  );
  console.error("  ports                           print the port map");
  process.exit(message === "" ? 0 : 1);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function packageNames(packagesDir: string): string[] {
  if (!existsSync(packagesDir)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgJson = join(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgJson)) {
      continue;
    }
    const parsed: unknown = JSON.parse(readFileSync(pkgJson, "utf8"));
    const name =
      typeof parsed === "object" && parsed !== null && "name" in parsed
        ? String(parsed["name"])
        : null;
    names.push(name === null ? entry.name : name);
  }
  return names;
}

async function addWorktree(
  slug: string,
  branchOpt: string | undefined,
  flags: Flags,
): Promise<void> {
  validateAddSlug(slug);
  const checkout = resolveCheckout();
  const worktreePath = join(checkout.mainRoot, ".worktrees", slug);
  if (existsSync(worktreePath)) {
    fail(`${worktreePath} already exists (remove it first, or pick another slug)`);
  }
  const branch = branchOpt ?? `wt/${slug}`;
  gitAddWorktree(checkout.mainRoot, worktreePath, branch);

  const registry = loadRegistry(checkout.mainRoot);
  const entry = await buildEntry(registry, slug, branch, worktreePath, flags);
  wireWorktreeFiles(checkout, entry);
  const depsMode = await linkOrInstallDeps(checkout.mainRoot, worktreePath);
  copyPackageDists(checkout.mainRoot, worktreePath);
  await registerPortless(entry);

  registry.worktrees.push(entry);
  saveRegistry(checkout.mainRoot, registry);
  reportAdd(entry, depsMode);
}

function validateAddSlug(slug: string): void {
  if (slug === "" || slug === "main" || slug.length < 2) {
    fail(`Invalid slug "${slug}"`);
  }
}

function gitAddWorktree(mainRoot: string, worktreePath: string, branch: string): void {
  const branchExists = gitQuiet(["show-ref", "--verify", `refs/heads/${branch}`], {
    cwd: mainRoot,
  });
  console.log(
    `Creating worktree at ${worktreePath} (${branchExists ? "existing" : "new"} branch ${branch})`,
  );
  const addArgs = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", worktreePath, "-b", branch];
  git(addArgs, { cwd: mainRoot });
}

async function buildEntry(
  registry: Registry,
  slug: string,
  branch: string,
  worktreePath: string,
  flags: Flags,
): Promise<WorktreeEntry> {
  const slot = await allocSlot(registry);
  const slotPortMap = slotPorts(slot);
  const mainConfig = readConvexConfig(join(registry.main.path, "app"));
  const shareStorage = !flags.fork && mainConfig !== null;
  return {
    slug,
    branch,
    path: worktreePath,
    storage: shareStorage ? "share" : "fork",
    slot,
    vitePort: slotPortMap.vite,
    convexPorts:
      shareStorage && mainConfig !== null
        ? { cloud: mainConfig.ports.cloud, site: mainConfig.ports.site }
        : null,
    portlessAlias: null,
    createdAt: new Date().toISOString(),
  };
}

function wireWorktreeFiles(checkout: { mainRoot: string }, entry: WorktreeEntry): void {
  const shareStorage = entry.storage === "share" && entry.convexPorts !== null;
  const envPorts =
    shareStorage && entry.convexPorts !== null ? entry.convexPorts : fallbackPorts(entry);
  prepareEnvFiles({ mainRoot: checkout.mainRoot }, entry, envPorts);
  if (shareStorage) {
    createSymlink(
      join(entry.path, "app", ".convex"),
      symlinkTarget(checkout.mainRoot, entry.path, "app/.convex"),
    );
  } else {
    console.log(
      "Note: fresh Convex storage for this worktree (empty local deployment, schema pushed on first dev run).",
    );
  }
}

function fallbackPorts(entry: WorktreeEntry): { cloud: number; site: number } {
  const guessed = slotPorts(entry.slot);
  return { cloud: guessed.cloud, site: guessed.site };
}

async function registerPortless(entry: WorktreeEntry): Promise<void> {
  const alias = `${PORTLESS_PREFIX}${entry.slug}`;
  const registered = await portlessAlias(alias, entry.vitePort);
  entry.portlessAlias = registered ? alias : null;
  if (registered) {
    console.log(`portless alias registered: https://${alias}.localhost`);
  } else {
    console.log(
      "portless not available (optional): install with `npm i -g portless` for named URLs.",
    );
  }
}

function reportAdd(entry: WorktreeEntry, depsMode: string): void {
  const alias = entry.portlessAlias;
  const convexUrl =
    entry.convexPorts === null
      ? "(chosen on first dev run)"
      : `http://127.0.0.1:${entry.convexPorts.cloud}`;
  console.log(`\nWorktree ready: ${entry.path}`);
  console.log(`  branch:        ${entry.branch}`);
  console.log(
    `  vite port:     ${entry.vitePort} -> http://localhost:${entry.vitePort}${alias !== null ? ` or https://${alias}.localhost` : ""}`,
  );
  console.log(`  convex:        ${convexUrl} (storage: ${entry.storage})`);
  console.log(`  node_modules:  ${depsMode}`);
  console.log(`\nNext:  cd ${join(".worktrees", entry.slug)} && bun run dev`);
  console.log(`Remove when merged:  bun run worktree remove ${entry.slug} --delete-branch`);
}

function prepareEnvFiles(
  checkout: { mainRoot: string },
  entry: WorktreeEntry,
  envPorts: { cloud: number; site: number },
): void {
  const rootEnv = join(checkout.mainRoot, ".env.local");
  if (existsSync(rootEnv)) {
    createSymlink(
      join(entry.path, ".env.local"),
      symlinkTarget(checkout.mainRoot, entry.path, ".env.local"),
    );
  }
  const mainAppEnv = join(checkout.mainRoot, "app", ".env.local");
  if (existsSync(mainAppEnv)) {
    const patched = patchEnvLocal(readFileSync(mainAppEnv, "utf8"), envPorts);
    writeFileSync(join(entry.path, "app", ".env.local"), patched);
  } else {
    writeAppEnvLocal(join(entry.path, "app"), { cloud: 3212, site: 3213 }, "local:unknown");
    console.warn(
      "Warn: main checkout has no app/.env.local; wrote a placeholder — run `bun run dev` in the main repo once.",
    );
  }
}

async function linkOrInstallDeps(mainRoot: string, worktreePath: string): Promise<string> {
  const mainLock = join(mainRoot, "bun.lock");
  const wtLock = join(worktreePath, "bun.lock");
  const mainNm = join(mainRoot, "node_modules");
  const hashesEqual =
    existsSync(mainLock) && existsSync(wtLock) && hashFile(mainLock) === hashFile(wtLock);

  if (hashesEqual && existsSync(mainNm)) {
    for (const rel of nodeModuleDirs(mainRoot)) {
      if (!existsSync(join(worktreePath, rel))) {
        createSymlink(join(worktreePath, rel), symlinkTarget(mainRoot, worktreePath, rel));
      }
    }
    return "symlinked from main checkout (bun.lock identical)";
  }
  console.log(
    "bun.lock differs from main checkout (or main has no node_modules) — installing fresh (shared bun cache keeps this fast)…",
  );
  const proc = Bun.spawnSync({
    cmd: ["bun", "install"],
    cwd: worktreePath,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    fail(`bun install failed in ${worktreePath}`);
  }
  return "installed in worktree";
}

function copyPackageDists(mainRoot: string, worktreePath: string): void {
  const names = packageNames(join(mainRoot, "packages"));
  for (const name of names) {
    const dirName = name.replace(/^@[^/]+\//, "");
    const copied = copyDirIfMissing(
      join(mainRoot, "packages", dirName, "dist"),
      join(worktreePath, "packages", dirName, "dist"),
    );
    if (copied) {
      console.log(
        `Copied packages/${dirName}/dist into the worktree (rebuild with \`bun run --filter=${name} build\`).`,
      );
    }
  }
}

async function allocSlot(registry: Registry): Promise<number> {
  const used = new Set(registry.worktrees.map((entry) => entry.slot));
  let slot = 1;
  while (used.has(slot)) {
    slot += 1;
  }
  while (!(await hasFreeSlotPorts(slotPorts(slot)))) {
    slot += 1;
  }
  return slot;
}

async function hasFreeSlotPorts(ports: {
  cloud: number;
  site: number;
  vite: number;
}): Promise<boolean> {
  for (const port of [ports.cloud, ports.site, ports.vite]) {
    if (!(await portFree(port))) {
      return false;
    }
  }
  return true;
}

async function listWorktrees(): Promise<void> {
  const checkout = resolveCheckout();
  const registry = loadRegistry(checkout.mainRoot);
  const base = mainBranch(registry);
  console.log(
    `Main: ${registry.main.path} (branch ${registry.main.branch}, convex 3212/3213, vite ${registry.main.ports.vite})`,
  );
  if (registry.worktrees.length === 0) {
    console.log("No worktrees registered.");
    return;
  }
  for (const entry of registry.worktrees) {
    const status = await worktreeStatus(entry, base);
    const branchLine = gitQuiet(["show-ref", "--verify", `refs/heads/${entry.branch}`])
      ? entry.branch
      : `${entry.branch} (branch gone)`;
    const convex =
      entry.convexPorts === null ? "fresh" : `${entry.convexPorts.cloud}/${entry.convexPorts.site}`;
    console.log(
      `- ${entry.slug}  ${status.padEnd(8)} branch ${branchLine}  storage ${entry.storage}  convex ${convex}  vite ${entry.vitePort}`,
    );
    console.log(`    ${entry.path}`);
  }
}

async function worktreeStatus(entry: WorktreeEntry, base: string): Promise<string> {
  if (!existsSync(entry.path)) {
    return "MISSING";
  }
  const merged = gitQuiet(["merge-base", "--is-ancestor", entry.branch, base]);
  if (merged) {
    return "MERGED";
  }
  return "ACTIVE";
}

function cleanupEntry(registry: Registry, entry: WorktreeEntry): void {
  if (entry.portlessAlias !== null) {
    portlessRemove(entry.portlessAlias);
  }
  registry.worktrees = registry.worktrees.filter((candidate) => candidate.slug !== entry.slug);
}

async function removeWorktree(slug: string, flags: Flags): Promise<void> {
  const checkout = resolveCheckout();
  const registry = loadRegistry(checkout.mainRoot);
  const entry = findEntry(registry, slug);
  if (entry === undefined) {
    fail(`No registered worktree "${slug}" (see \`bun run worktree list\`)`);
  }
  if (!flags.dryRun && existsSync(entry.path)) {
    git(
      flags.force
        ? ["worktree", "remove", "--force", entry.path]
        : ["worktree", "remove", entry.path],
      {
        cwd: checkout.mainRoot,
      },
    );
  }
  if (entry.portlessAlias !== null) {
    portlessRemove(entry.portlessAlias);
  }
  registry.worktrees = registry.worktrees.filter((candidate) => candidate.slug !== slug);
  git(["worktree", "prune"], { cwd: checkout.mainRoot });
  if (flags.deleteBranches && gitQuiet(["show-ref", "--verify", `refs/heads/${entry.branch}`])) {
    git(["branch", "-d", entry.branch], { cwd: checkout.mainRoot });
    if (!flags.quiet) {
      console.log(`Deleted branch ${entry.branch}`);
    }
  }
  saveRegistry(checkout.mainRoot, registry);
  if (!flags.quiet) {
    console.log(`Removed worktree ${slug}.`);
  }
}

async function cleanWorktrees(flags: Flags): Promise<void> {
  const checkout = resolveCheckout();
  const registry = loadRegistry(checkout.mainRoot);
  const base = mainBranch(registry);
  const removals = await collectStaleWorktrees(registry, base);
  if (removals.length === 0) {
    if (!flags.quiet) {
      console.log("No merged/missing worktrees to clean.");
    }
    return;
  }
  for (const entry of removals) {
    await cleanOne(checkout.mainRoot, registry, entry, flags, base);
  }
  git(["worktree", "prune"], { cwd: checkout.mainRoot });
  saveRegistry(checkout.mainRoot, registry);
}

async function collectStaleWorktrees(registry: Registry, base: string): Promise<WorktreeEntry[]> {
  const removals: WorktreeEntry[] = [];
  for (const entry of registry.worktrees) {
    const stale = await isStaleWorktree(entry, base);
    if (stale) {
      removals.push(entry);
    }
  }
  return removals;
}

async function isStaleWorktree(entry: WorktreeEntry, base: string): Promise<boolean> {
  const branchGone = !gitQuiet(["show-ref", "--verify", `refs/heads/${entry.branch}`]);
  const status = await worktreeStatus(entry, base);
  return branchGone || status !== "ACTIVE";
}

async function cleanOne(
  mainRoot: string,
  registry: Registry,
  entry: WorktreeEntry,
  flags: Flags,
  base: string,
): Promise<void> {
  if (flags.dryRun) {
    console.log(`Would remove ${entry.slug} (${entry.path})`);
    return;
  }
  if (existsSync(entry.path) && !(await removeWorktreeDir(mainRoot, entry, flags))) {
    return;
  }
  cleanupEntry(registry, entry);
  deleteBranchIfPresent(mainRoot, entry, flags);
  if (!flags.quiet) {
    console.log(`Removed worktree ${entry.slug} (merged into ${base} or stale).`);
  }
}

async function removeWorktreeDir(
  mainRoot: string,
  entry: WorktreeEntry,
  flags: Flags,
): Promise<boolean> {
  try {
    git(
      flags.force
        ? ["worktree", "remove", "--force", entry.path]
        : ["worktree", "remove", entry.path],
      { cwd: mainRoot },
    );
    return true;
  } catch (err) {
    console.warn(`Skip ${entry.slug}: ${String(err)}`);
    return false;
  }
}

function deleteBranchIfPresent(mainRoot: string, entry: WorktreeEntry, flags: Flags): void {
  if (flags.deleteBranches && gitQuiet(["show-ref", "--verify", `refs/heads/${entry.branch}`])) {
    git(["branch", "-d", entry.branch], { cwd: mainRoot });
  }
}

async function showPorts(): Promise<void> {
  const checkout = resolveCheckout();
  const registry = loadRegistry(checkout.mainRoot);
  const mainConfig = readConvexConfig(join(checkout.mainRoot, "app"));
  const mainConvex =
    mainConfig === null ? "not initialized" : `${mainConfig.ports.cloud}/${mainConfig.ports.site}`;
  console.log(`main       convex ${mainConvex}  vite ${registry.main.ports.vite}`);
  for (const entry of registry.worktrees) {
    const convex =
      entry.convexPorts === null
        ? "fresh (chosen at dev start)"
        : `${entry.convexPorts.cloud}/${entry.convexPorts.site}`;
    console.log(`${entry.slug.padEnd(11)} convex ${convex}  vite ${entry.vitePort}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const rest = args.slice(1).filter((arg) => !arg.startsWith("--"));
  const flags = parseFlags(args);

  switch (command) {
    case "add": {
      if (rest.length < 1) {
        usage("`worktree add <slug> [branch]`");
      }
      await addWorktree(normalizeSlug(rest[0]), rest[1], flags);
      break;
    }
    case "list": {
      await listWorktrees();
      break;
    }
    case "remove": {
      if (rest.length < 1) {
        usage("`worktree remove <slug> [--force] [--delete-branch]`");
      }
      await removeWorktree(normalizeSlug(rest[0]), flags);
      break;
    }
    case "clean": {
      await cleanWorktrees(flags);
      break;
    }
    case "ports": {
      await showPorts();
      break;
    }
    default: {
      usage("");
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(`Error: ${String(err)}`);
  process.exit(1);
}
