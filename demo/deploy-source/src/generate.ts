import {
  DEPLOYMENT_STATUSES,
  type Deployment,
  type DeploymentPatch,
  type DeploymentStore,
  type LayerKey,
  type RouteCoordinates,
} from "./store";

/**
 * Deterministic fixture generation and random churn. A fixed seed yields the
 * same deployments every reseed, so screenshots and tests stay comparable.
 */

export type Rng = () => number;

/** Park–Miller minimal-standard PRNG (arithmetic only — the repo lints out bitwise ops). */
export function createRng(seed: number): Rng {
  const modulus = 2_147_483_647;
  let state = Math.abs(Math.floor(seed)) % modulus;
  if (state === 0) {
    state = 1;
  }
  return () => {
    state = (state * 48_271) % modulus;
    return (state - 1) / (modulus - 1);
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("pick() needs a non-empty list");
  }
  return item;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const REGIONS = [
  { center: [-122.2, 37.6], key: "us-west" },
  { center: [-104.9, 39.7], key: "us-central" },
  { center: [-96.8, 32.8], key: "us-south" },
  { center: [-77.0, 38.9], key: "us-east" },
] as const;

const ENVIRONMENTS = ["production", "staging", "edge"] as const;
const OWNERS = ["platform", "networking", "data", "sre"] as const;
const WORDS = [
  "atlas",
  "beacon",
  "cinder",
  "delta",
  "ember",
  "fjord",
  "granite",
  "harbor",
  "ion",
  "juniper",
  "kestrel",
  "lumen",
] as const;
// Weighted toward "live" so the map reads like a real fleet.
const STATUS_WEIGHTS = ["planned", "live", "live", "live", "live", "degraded", "retired"] as const;
const NOTES = [
  "Waiting on change-advisory sign-off.",
  "Paged twice last week; see incident log.",
  "Owner rotating next quarter.",
  "",
] as const;

const BASE_DATE = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;
// Share of deployments that also carry a secondary MultiLineString.
const ROUTE_SHARE = 0.3;

/** A 1–3 line MultiLineString random-walking away from the centroid. */
export function randomRoute(rng: Rng, lng: number, lat: number): RouteCoordinates {
  const lines: RouteCoordinates = [];
  const lineCount = 1 + Math.floor(rng() * 3);
  for (let line = 0; line < lineCount; line += 1) {
    let x = lng + (rng() - 0.5) * 0.02;
    let y = lat + (rng() - 0.5) * 0.02;
    let heading = rng() * Math.PI * 2;
    const positions = [[round6(x), round6(y)]];
    const pointCount = 4 + Math.floor(rng() * 5);
    for (let point = 1; point < pointCount; point += 1) {
      heading += (rng() - 0.5) * 0.8;
      x += Math.cos(heading) * 0.04;
      y += Math.sin(heading) * 0.04;
      positions.push([round6(x), round6(y)]);
    }
    lines.push(positions);
  }
  return lines;
}

export function randomDeployment(rng: Rng, id: string, ordinal: number): Deployment {
  const region = pick(rng, REGIONS);
  const lng = round6(region.center[0] + (rng() - 0.5) * 3);
  const lat = round6(region.center[1] + (rng() - 0.5) * 2);
  return {
    deployedAt: new Date(BASE_DATE + Math.floor(rng() * 600) * DAY_MS).toISOString(),
    environment: pick(rng, ENVIRONMENTS),
    id,
    lat,
    lng,
    name: `${region.key}-${pick(rng, WORDS)}-${ordinal}`,
    notes: pick(rng, NOTES),
    owner: pick(rng, OWNERS),
    region: region.key,
    route: rng() < ROUTE_SHARE ? randomRoute(rng, lng, lat) : null,
    status: pick(rng, STATUS_WEIGHTS),
    version: `v${1 + Math.floor(rng() * 4)}.${Math.floor(rng() * 20)}.${Math.floor(rng() * 10)}`,
  };
}

export function generateDeployments(count: number, seed: number): Deployment[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, index) =>
    randomDeployment(rng, `dep_${String(index + 1).padStart(4, "0")}`, index + 1),
  );
}

export interface ChurnEvent {
  id: string;
  layers: LayerKey[];
  op: string;
}

type ChurnOp = (store: DeploymentStore, rng: Rng, target: Deployment) => ChurnEvent | null;

function patchOp(op: string, build: (rng: Rng, target: Deployment) => DeploymentPatch): ChurnOp {
  return (store, rng, target) => {
    const layers = store.update(target.id, build(rng, target));
    return layers === null ? null : { id: target.id, layers, op };
  };
}

// Weighted by repetition. `notes` edits deliberately touch no exported
// field, so they must NOT bump any layer revision.
const CHURN_OPS: readonly ChurnOp[] = [
  patchOp("move", (rng, t) => ({
    lat: round6(t.lat + (rng() - 0.5) * 0.2),
    lng: round6(t.lng + (rng() - 0.5) * 0.2),
  })),
  patchOp("move", (rng, t) => ({
    lat: round6(t.lat + (rng() - 0.5) * 0.2),
    lng: round6(t.lng + (rng() - 0.5) * 0.2),
  })),
  patchOp("status", (rng) => ({ status: pick(rng, DEPLOYMENT_STATUSES) })),
  patchOp("status", (rng) => ({ status: pick(rng, DEPLOYMENT_STATUSES) })),
  patchOp("reroute", (rng, t) => ({ route: randomRoute(rng, t.lng, t.lat) })),
  patchOp("drop-route", () => ({ route: null })),
  patchOp("notes", (rng) => ({ notes: pick(rng, NOTES) })),
  (store, rng) => {
    const id = `dep_n${Date.now().toString(36)}${Math.floor(rng() * 1e6).toString(36)}`;
    const layers = store.insert(randomDeployment(rng, id, Math.floor(rng() * 9000) + 1000));
    return { id, layers, op: "create" };
  },
  (store, _rng, target) => {
    const layers = store.remove(target.id);
    return layers === null ? null : { id: target.id, layers, op: "delete" };
  },
];

/** Applies `count` random writes — the "someone edited the source app" button. */
export function churn(store: DeploymentStore, rng: Rng, count: number): ChurnEvent[] {
  const events: ChurnEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const deployments = store.all();
    if (deployments.length === 0) {
      break;
    }
    const event = pick(rng, CHURN_OPS)(store, rng, pick(rng, deployments));
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}
