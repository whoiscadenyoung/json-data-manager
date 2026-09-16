/**
 * Port-aware dev orchestrator: runs the Convex local backend and the Vite
 * frontend with per-checkout ports so main and any number of worktrees (and
 * other projects) can run side by side without conflicts.
 *
 *   bun run dev              in the main repo or any .worktrees/<slug> checkout
 *   bun run dev --dry-run    print resolved ports/URLs without starting anything
 *   bun run dev --no-portless
 *
 * URL: each checkout gets a stable vite port from .worktrees/registry.json and
 * (optionally) a portless alias `https://jdm-<slug>.localhost`. The Convex URL
 * is exported as VITE_CONVEX_URL so the frontend always points at the live
 * local backend, whatever port it landed on.
 *
 * See docs/dev-environment.md.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  type Checkout,
  type Registry,
  type WorktreeEntry,
  PORTLESS_PREFIX,
  copyDirIfMissing,
  createSymlink,
  findEntry,
  git,
  hashFile,
  loadRegistry,
  nodeModuleDirs,
  patchEnvLocal,
  portFree,
  portless,
  portlessAlias,
  readConvexConfig,
  resolveCheckout,
  saveRegistry,
  slotPorts,
  symlinkTarget,
  writeAppEnvLocal,
} from "./lib.ts";

const BACKEND_WAIT_MS = 180_000;

type Options = { dryRun: boolean; usePortless: boolean };

type Resolved = {
  checkout: Checkout;
  registry: Registry;
  entry: WorktreeEntry | null;
  slug: string;
  appDir: string;
  deployment: string;
  shareMode: boolean;
  convexPorts: { cloud: number; site: number };
  vitePort: number;
  alias: string;
  hasPortless: boolean;
};

type Child = { label: string; proc: ReturnType<typeof Bun.spawn> };

function parseOptions(args: string[]): Options {
  return { dryRun: args.includes("--dry-run"), usePortless: !args.includes("--no-portless") };
}

function mainAppDir(checkout: Checkout): string {
  return join(checkout.mainRoot, "app");
}

function thisAppDir(checkout: Checkout): string {
  return join(checkout.checkoutRoot, "app");
}

function readDeploymentName(appDir: string): string {
  const envPath = join(appDir, ".env.local");
  if (!existsSync(envPath)) {
    return "";
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1 && line.slice(0, eq).trim() === "CONVEX_DEPLOYMENT") {
      // ".env.local" stores "local:<name>"; the backend answers /instance_name
      // with the bare deployment name.
      const value = line
        .slice(eq + 1)
        .split(" ")[0]
        .trim();
      const colon = value.indexOf(":");
      return colon === -1 ? value : value.slice(colon + 1);
    }
  }
  return "";
}

async function nextFreeSlot(registry: Registry): Promise<number> {
  const used = new Set(registry.worktrees.map((entry) => entry.slot));
  let slot = 1;
  while (used.has(slot)) {
    slot += 1;
  }
  while (!(await portFree(slotPorts(slot).vite))) {
    slot += 1;
  }
  return slot;
}

/** Resolve (and lazily register) the registry entry for this checkout. */
async function entryFor(
  checkout: Checkout,
  registry: Registry,
): Promise<{ entry: WorktreeEntry | null; slug: string }> {
  if (!checkout.isWorktree) {
    return { entry: null, slug: "main" };
  }
  const slug = checkout.slug ?? checkout.checkoutRoot.split("/").pop() ?? "worktree";
  let entry = findEntry(registry, slug);
  if (entry === undefined) {
    console.log(`Unregistered checkout "${slug}" — registering it in the worktree registry…`);
    entry = await adoptCheckout(registry, slug, checkout);
    registry.worktrees.push(entry);
    saveRegistry(checkout.mainRoot, registry);
  }
  return { entry, slug };
}

async function adoptCheckout(
  registry: Registry,
  slug: string,
  checkout: Checkout,
): Promise<WorktreeEntry> {
  const slot = await nextFreeSlot(registry);
  const ports = slotPorts(slot);
  const appDir = thisAppDir(checkout);
  const storageSymlinked = existsSync(join(appDir, ".convex"));
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: checkout.checkoutRoot });
  const mainConfig = readConvexConfig(mainAppDir(checkout));
  return {
    slug,
    branch,
    path: checkout.checkoutRoot,
    storage: storageSymlinked ? "share" : "fork",
    slot,
    vitePort: ports.vite,
    convexPorts: mainConfig === null ? null : mainConfig.ports,
    portlessAlias: null,
    createdAt: new Date().toISOString(),
  };
}

/** Resolve everything about this checkout: ports, storage mode, alias, backend reachability. */
async function resolveContext(options: Options): Promise<Resolved> {
  const checkout = resolveCheckout();
  const registry = loadRegistry(checkout.mainRoot);
  const { entry, slug } = await entryFor(checkout, registry);
  const appDir = thisAppDir(checkout);
  const deployment = readDeploymentName(appDir);
  const shareMode = entry === null || entry.storage === "share";
  const mainConfig = readConvexConfig(mainAppDir(checkout));

  if (shareMode && mainConfig === null) {
    console.error(
      "Error: no local Convex deployment configured in the main checkout (run `bun run dev` there once).",
    );
    process.exit(1);
  }
  const convexPorts = shareConvexPorts(entry, shareMode, mainConfig);
  const alias = `${PORTLESS_PREFIX}${slug}`;
  return {
    checkout,
    registry,
    entry,
    slug,
    appDir,
    deployment,
    shareMode,
    convexPorts,
    vitePort: entry === null ? registry.main.ports.vite : entry.vitePort,
    alias,
    hasPortless: options.usePortless && portless() !== null,
  };
}

function shareConvexPorts(
  entry: WorktreeEntry | null,
  shareMode: boolean,
  mainConfig: { ports: { cloud: number; site: number } } | null,
): { cloud: number; site: number } {
  if (shareMode && mainConfig !== null) {
    return mainConfig.ports;
  }
  if (entry !== null && entry.convexPorts !== null) {
    return entry.convexPorts;
  }
  return slotPorts(entry === null ? 1 : entry.slot);
}

/** Pick a free vite port, preferring the requested one; report reassignments. */
async function pickVitePort(requested: number): Promise<number> {
  if (await portFree(requested)) {
    return requested;
  }
  let port = requested + 1;
  while (!(await portFree(port))) {
    port += 1;
  }
  console.log(`Port ${requested} is busy — using ${port} instead.`);
  return port;
}

/**
 * Keep dependencies consistent for this checkout: worktrees symlink the main
 * checkout's node_modules when bun.lock matches, otherwise install fresh
 * (bun's global cache dedupes the downloads). Replaces stale symlinks.
 */
async function ensureDeps(checkout: Checkout, options: Options): Promise<string> {
  if (!checkout.isWorktree) {
    if (!existsSync(join(checkout.checkoutRoot, "node_modules"))) {
      if (options.dryRun) {
        return "would `bun install` (no node_modules)";
      }
      runInstall(checkout.checkoutRoot);
    }
    return "real (main checkout owns it)";
  }
  return ensureWorktreeDeps(checkout, options);
}

async function ensureWorktreeDeps(checkout: Checkout, options: Options): Promise<string> {
  const mainLock = join(checkout.mainRoot, "bun.lock");
  const wtLock = join(checkout.checkoutRoot, "bun.lock");
  const hashesEqual =
    existsSync(mainLock) && existsSync(wtLock) && hashFile(mainLock) === hashFile(wtLock);
  const links = nodeModuleDirs(checkout.mainRoot);

  if (hashesEqual && existsSync(join(checkout.mainRoot, "node_modules"))) {
    return linkWorktreeDeps(checkout, links, options);
  }
  if (options.dryRun) {
    return "would unlink shared symlinks and `bun install` (bun.lock drifted)";
  }
  console.log(
    "bun.lock differs from the main checkout — unlinking shared node_modules and installing fresh…",
  );
  unlinkSharedLinks(checkout.checkoutRoot, links);
  runInstall(checkout.checkoutRoot);
  return "installed in this checkout";
}

async function linkWorktreeDeps(
  checkout: Checkout,
  links: string[],
  options: Options,
): Promise<string> {
  if (options.dryRun) {
    return "symlinked from main checkout";
  }
  let relinked = 0;
  for (const rel of links) {
    const linkPath = join(checkout.checkoutRoot, rel);
    if (!existsSync(linkPath)) {
      createSymlink(linkPath, symlinkTarget(checkout.mainRoot, checkout.checkoutRoot, rel));
      relinked += 1;
    }
  }
  if (relinked > 0) {
    console.log(`Symlinked ${relinked} node_modules dir(s) from the main checkout.`);
  }
  return "symlinked from main checkout (bun.lock identical)";
}

function unlinkSharedLinks(checkoutRoot: string, links: string[]): void {
  for (const rel of links) {
    const linkPath = join(checkoutRoot, rel);
    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
      unlinkSync(linkPath);
    }
  }
}

function runInstall(cwd: string): void {
  const proc = Bun.spawnSync({
    cmd: ["bun", "install"],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error(`Error: bun install failed in ${cwd}`);
    process.exit(1);
  }
}

/** Make sure local component-library build output exists for the app to import. */
function ensurePackageDists(checkout: Checkout, options: Options): void {
  const packagesDir = join(checkout.mainRoot, "packages");
  if (!existsSync(packagesDir) || options.dryRun) {
    return;
  }
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue;
    }
    copyDistIfPresent(packagesDir, dir.name, checkout);
  }
}

function copyDistIfPresent(packagesDir: string, dirName: string, checkout: Checkout): void {
  const pkgJson = join(packagesDir, dirName, "package.json");
  if (!existsSync(pkgJson)) {
    return;
  }
  const parsed: unknown = JSON.parse(readFileSync(pkgJson, "utf8"));
  const name =
    typeof parsed === "object" && parsed !== null && "name" in parsed
      ? String(parsed["name"])
      : null;
  if (name === null) {
    return;
  }
  const srcDist = join(packagesDir, dirName, "dist");
  const destDist = join(checkout.checkoutRoot, "packages", dirName, "dist");
  if (!existsSync(srcDist) && !existsSync(destDist)) {
    console.warn(
      `Warn: packages/${dirName}/dist is missing everywhere; run \`bun run --filter=${name} build\` if the app fails to start.`,
    );
    return;
  }
  copyDirIfMissing(srcDist, destDist);
}

async function backendAnswering(cloudPort: number, deployment: string): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${cloudPort}/instance_name`, {
      signal: AbortSignal.timeout(800),
    });
    if (resp.status === 200) {
      return (await resp.text()).trim() === deployment;
    }
  } catch {
    // not listening
  }
  return false;
}

function convexUrlPort(port: number): string {
  return `127.0.0.1:${port}`;
}

/**
 * Child env: bun auto-loads the repo-root .env.local into this process, and a
 * process-env CONVEX_DEPLOYMENT would override the checkout's own
 * app/.env.local (e.g. steering `convex dev` at a stale cloud deployment).
 * Scrub it so the checkout's .env.local is authoritative.
 */
function childEnv(extra: Record<string, string>) {
  const env = { ...process.env, ...extra };
  delete env["CONVEX_DEPLOYMENT"];
  return env;
}

/**
 * Wait for the backend described by this checkout's .convex config. Re-reads
 * the config while polling because the CLI can reassign ports when its
 * preferred ones are taken (e.g. a fresh forked deployment).
 */
async function waitBackendWithConfigReadback(
  appDir: string,
  expectedName: string,
): Promise<boolean> {
  let lastPorts: { cloud: number; site: number } | null = null;
  const deadline = Date.now() + BACKEND_WAIT_MS;
  while (Date.now() < deadline) {
    const config = readConvexConfig(appDir);
    lastPorts = await pollBackendOnce(config, lastPorts, expectedName);
    if (lastPorts === null) {
      return true;
    }
    await Bun.sleep(500);
  }
  return false;
}

/** One poll iteration; returns null when the backend is confirmed up. */
async function pollBackendOnce(
  config: { ports: { cloud: number; site: number }; deploymentName: string } | null,
  lastPorts: { cloud: number; site: number } | null,
  expectedName: string,
): Promise<{ cloud: number; site: number } | null> {
  if (config === null) {
    return lastPorts;
  }
  if (lastPorts === null || lastPorts.cloud !== config.ports.cloud) {
    console.log(`Waiting for backend on port ${config.ports.cloud} (${config.deploymentName})…`);
  }
  const name = expectedName !== "" ? expectedName : config.deploymentName;
  if (await backendAnswering(config.ports.cloud, name)) {
    return null;
  }
  return config.ports;
}

function printDryRun(resolved: Resolved, depsPlan: string, attach: boolean): void {
  console.log(`checkout:      ${resolved.checkout.checkoutRoot}`);
  console.log(
    `slug:          ${resolved.slug} (${resolved.entry === null ? "main" : `worktree, slot ${resolved.entry.slot}`})`,
  );
  console.log(
    `storage:       ${resolved.shareMode ? "shared with main checkout" : "forked (fresh)"}`,
  );
  console.log(
    `convex:        http://${convexUrlPort(resolved.convexPorts.cloud)}  http://${convexUrlPort(resolved.convexPorts.site)}`,
  );
  console.log(
    `vite:          http://localhost:${resolved.vitePort}${resolved.hasPortless ? `  https://${resolved.alias}.localhost` : ""}`,
  );
  console.log(
    `mode:          ${attach ? "attach (backend already running, frontend only)" : "full (convex dev + vite)"}`,
  );
  console.log(`deps:          ${depsPlan}`);
}

async function startBackend(resolved: Resolved, children: Child[]): Promise<boolean> {
  const { appDir, deployment, convexPorts } = resolved;
  console.log(`Starting convex dev (backend on ${convexPorts.cloud}/${convexPorts.site})…`);
  const convexProc = Bun.spawn({
    cmd: ["bunx", "convex", "dev", "--env-file", join(".env.local")],
    cwd: appDir,
    env: childEnv({}),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push({ label: "convex dev", proc: convexProc });
  const configAtStart = readConvexConfig(appDir);
  const expectedName =
    deployment !== "" ? deployment : configAtStart === null ? "" : configAtStart.deploymentName;
  const up = await waitBackendWithConfigReadback(appDir, expectedName);
  if (!up) {
    console.error(
      "Error: local Convex backend did not come up in time. Check the log output above.",
    );
    for (const child of children) {
      child.proc.kill("SIGTERM");
    }
  }
  return up;
}

function spawnVite(resolved: Resolved, vitePort: number): Child {
  console.log(`Starting vite on port ${vitePort}…`);
  const proc = Bun.spawn({
    cmd: ["bunx", "vite", "dev", "--port", String(vitePort), "--host", "127.0.0.1", "--strictPort"],
    cwd: resolved.appDir,
    env: childEnv({
      VITE_CONVEX_URL: `http://${convexUrlPort(resolved.convexPorts.cloud)}`,
      VITE_CONVEX_SITE_URL: `http://${convexUrlPort(resolved.convexPorts.site)}`,
    }),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { label: "vite", proc };
}

function syncAfterStart(session: Session): void {
  const { resolved } = session;
  const { entry, registry } = resolved;
  if (entry === null) {
    if (session.vitePort !== registry.main.ports.vite) {
      registry.main.ports.vite = session.vitePort;
      saveRegistry(resolved.checkout.mainRoot, registry);
    }
    return;
  }
  entry.convexPorts = resolved.convexPorts;
  entry.vitePort = session.vitePort;
  if (session.portlessOk) {
    entry.portlessAlias = resolved.alias;
  }
  syncWorktreeEnv(resolved.appDir, resolved.convexPorts);
  saveRegistry(resolved.checkout.mainRoot, registry);
}

function syncWorktreeEnv(appDir: string, ports: { cloud: number; site: number }): void {
  const envPath = join(appDir, ".env.local");
  if (!existsSync(envPath)) {
    writeAppEnvLocal(appDir, ports, "local:unknown");
    return;
  }
  writeFileSync(envPath, patchEnvLocal(readFileSync(envPath, "utf8"), ports));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const resolved = await resolveContext(options);

  if (options.dryRun) {
    const depsPlan = await ensureDeps(resolved.checkout, options);
    const attach =
      resolved.shareMode &&
      resolved.deployment !== "" &&
      (await backendAnswering(resolved.convexPorts.cloud, resolved.deployment));
    printDryRun(resolved, depsPlan, attach);
    return;
  }

  await runSession(resolved);
}

type Session = {
  resolved: Resolved;
  vitePort: number;
  children: Child[];
  shuttingDown: boolean;
  portlessOk: boolean;
};

async function runSession(resolved: Resolved): Promise<void> {
  const depsState = await ensureDeps(resolved.checkout, { dryRun: false, usePortless: true });
  console.log(`deps: ${depsState}`);
  ensurePackageDists(resolved.checkout, { dryRun: false, usePortless: false });
  resolved.vitePort = await pickVitePort(resolved.vitePort);

  const session: Session = {
    resolved,
    vitePort: resolved.vitePort,
    children: [],
    shuttingDown: false,
    portlessOk: false,
  };
  installSignalHandlers(session);

  const mode = await startBackendIfStandalone(resolved, session);
  if (mode === null) {
    process.exit(1);
  }
  session.children.push(spawnVite(resolved, session.vitePort));
  await registerPortlessAlias(session);
  syncAfterStart(session);

  printReady(resolved, session, mode);
  await awaitFirstExit(session);
}

/**
 * In share mode with the deployment's backend already running, attach to it
 * (frontend only). Otherwise start `convex dev`; returns null on failure.
 */
async function startBackendIfStandalone(
  resolved: Resolved,
  session: Session,
): Promise<"attach" | "full" | null> {
  if (
    resolved.shareMode &&
    resolved.deployment !== "" &&
    (await backendAnswering(resolved.convexPorts.cloud, resolved.deployment))
  ) {
    console.log(
      `A local backend for this deployment is already running on port ${resolved.convexPorts.cloud} — attaching the frontend only.`,
    );
    return "attach";
  }
  const started = await startBackend(resolved, session.children);
  if (!started) {
    return null;
  }
  const configAfterUp = readConvexConfig(resolved.appDir);
  resolved.convexPorts = configAfterUp === null ? resolved.convexPorts : configAfterUp.ports;
  return "full";
}

function installSignalHandlers(session: Session): void {
  const stop = (signal: string): void => {
    if (session.shuttingDown) {
      return;
    }
    session.shuttingDown = true;
    console.log(`\nStopping (${signal})…`);
    for (const child of session.children) {
      child.proc.kill("SIGTERM");
    }
    process.exit(130);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

async function registerPortlessAlias(session: Session): Promise<void> {
  if (!session.resolved.hasPortless) {
    return;
  }
  const ok = await portlessAlias(session.resolved.alias, session.vitePort);
  session.portlessOk = ok;
  if (ok) {
    console.log(
      `portless: https://${session.resolved.alias}.localhost -> http://localhost:${session.vitePort}`,
    );
  } else {
    console.log("portless is installed but the alias failed — is `portless proxy start` running?");
  }
}

async function awaitFirstExit(session: Session): Promise<void> {
  const exited = await Promise.race(
    session.children.map(async (child) => ({ child, code: await child.proc.exited })),
  );
  if (!session.shuttingDown) {
    session.shuttingDown = true;
    console.log(`\n${exited.child.label} exited (code ${exited.code}) — stopping the rest.`);
    for (const child of session.children) {
      child.proc.kill("SIGTERM");
    }
    process.exit(exited.code ?? 1);
  }
}

function printReady(resolved: Resolved, session: Session, mode: "attach" | "full"): void {
  console.log(`\nReady (${mode} mode):`);
  console.log(
    `  frontend: http://localhost:${session.vitePort}${resolved.hasPortless ? `  |  https://${resolved.alias}.localhost` : ""}`,
  );
  console.log(
    `  convex:   http://${convexUrlPort(resolved.convexPorts.cloud)}  http://${convexUrlPort(resolved.convexPorts.site)}`,
  );
  console.log("  Ctrl+C stops everything.");
}

try {
  await main();
} catch (err) {
  console.error(`Error: ${String(err)}`);
  process.exit(1);
}
