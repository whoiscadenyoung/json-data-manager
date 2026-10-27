/**
 * Runtime settings, all overridable from the environment so the demo can
 * stand in for differently configured foreign deployments.
 */
const port = Number(process.env.DEPLOY_SOURCE_PORT ?? "4100");

export const config = {
  // How many deployments `seed` generates, and the PRNG seed that makes the
  // fixture deterministic (same seed → same rows, ids, and routes).
  count: Number(process.env.DEPLOY_SOURCE_COUNT ?? "200"),
  dbPath:
    process.env.DEPLOY_SOURCE_DB ??
    new URL("../data/deploy-source.sqlite", import.meta.url).pathname,
  port,
  // The base the manifest's record deep links point at.
  publicUrl: process.env.DEPLOY_SOURCE_PUBLIC_URL ?? `http://localhost:${port}`,
  seed: Number(process.env.DEPLOY_SOURCE_SEED ?? "42"),
  // The shared bearer secret json-data-manager sends (its
  // REMOTE_SOURCE_DEPLOYMENTS_SECRET). Demo default only.
  token: process.env.DEPLOY_SOURCE_TOKEN ?? "demo-secret",
};
