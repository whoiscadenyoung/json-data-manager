import type { Deployment, DeploymentStore, LayerKey } from "./store";
import { LAYER_KEYS } from "./store";

/**
 * The remote-source HTTP contract json-data-manager reads
 * (docs/remote-source-adapter-design.md §2): a manifest describing each
 * layer and its current revision, and keyset-paged FeatureCollections per
 * layer. Pure functions over the store — the server adds auth and faults.
 */

export const API_VERSION = 1;
export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 1000;

interface LayerDescriptor {
  description: string;
  geometryType: "MultiLineString" | "Point";
  schema: Record<string, unknown>;
  // Bumped by hand whenever a layer's exported fields change shape —
  // json-data-manager flags the binding instead of writing mismatched rows.
  schemaVersion: string;
  title: string;
}

const STATUS_SCHEMA = { enum: ["planned", "live", "degraded", "retired"], type: "string" };

const LAYERS: Record<LayerKey, LayerDescriptor> = {
  centroids: {
    description: "One point per deployment, carrying its exported attributes.",
    geometryType: "Point",
    schema: {
      properties: {
        deployedAt: { format: "date-time", type: "string" },
        environment: { type: "string" },
        name: { type: "string" },
        owner: { type: "string" },
        region: { type: "string" },
        status: STATUS_SCHEMA,
        version: { type: "string" },
      },
      required: ["name", "status", "region"],
      type: "object",
    },
    schemaVersion: "1",
    title: "Deployments",
  },
  routes: {
    description:
      "Secondary MultiLineString geometry, present only on deployments that have one. Keyed by the same deployment id as the centroid layer.",
    geometryType: "MultiLineString",
    schema: {
      properties: {
        deploymentId: {
          description: "The centroid layer's key for this deployment.",
          type: "string",
        },
        name: { type: "string" },
        status: STATUS_SCHEMA,
      },
      required: ["deploymentId", "name", "status"],
      type: "object",
    },
    schemaVersion: "1",
    title: "Deployment routes",
  },
};

export function buildManifest(store: DeploymentStore, publicUrl: string) {
  const revisions = store.revisions();
  return {
    apiVersion: API_VERSION,
    description: "Deployment records from the deployment-data app (demo stand-in).",
    layers: LAYER_KEYS.map((key) =>
      Object.assign({}, LAYERS[key], {
        featureCount: store.countLayer(key),
        key,
        revision: revisions[key].revision,
        rowsPath: `/layers/${key}/rows`,
        updatedAt: revisions[key].updatedAt,
      }),
    ),
    recordUrlTemplate: `${publicUrl}/deployments/{key}`,
    source: "deployments",
    title: "Deployments",
  };
}

function toFeature(layer: LayerKey, deployment: Deployment) {
  if (layer === "routes") {
    return {
      geometry: { coordinates: deployment.route, type: "MultiLineString" },
      id: deployment.id,
      properties: {
        deploymentId: deployment.id,
        name: deployment.name,
        status: deployment.status,
      },
      type: "Feature",
    };
  }
  return {
    geometry: { coordinates: [deployment.lng, deployment.lat], type: "Point" },
    id: deployment.id,
    properties: {
      deployedAt: deployment.deployedAt,
      environment: deployment.environment,
      name: deployment.name,
      owner: deployment.owner,
      region: deployment.region,
      status: deployment.status,
      version: deployment.version,
    },
    type: "Feature",
  };
}

/**
 * One page of a layer as a GeoJSON FeatureCollection. `cursor` and
 * `revision` are foreign members: `cursor: null` ends the drain, and
 * `revision` is the layer's revision when this page was read — the host
 * records the FIRST page's revision as what it synced to, so a write landing
 * mid-drain shows up as "out of date" again rather than being skipped.
 */
export function buildRowsPage(
  store: DeploymentStore,
  layer: LayerKey,
  cursor: string | null,
  limit: number,
) {
  const revision = store.revisions()[layer].revision;
  const page = store.page(layer, cursor, limit);
  return {
    cursor: page.cursor,
    features: page.rows.map((deployment) => toFeature(layer, deployment)),
    layer,
    revision,
    type: "FeatureCollection",
  };
}

export function parsePageSize(raw: string | null): number {
  const parsed = raw === null ? DEFAULT_PAGE_SIZE : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}
