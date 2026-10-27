import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The demo's "system of record": one deployments table plus a per-layer
 * revision counter. Each deployment has a centroid (always) and an optional
 * secondary MultiLineString route — the two geometries the contract serves
 * as separate layers, because json-data-manager holds one geometry per entry.
 */

export type LayerKey = "centroids" | "routes";
export const LAYER_KEYS: readonly LayerKey[] = ["centroids", "routes"];

export function isLayerKey(value: string): value is LayerKey {
  return value === "centroids" || value === "routes";
}

export type DeploymentStatus = "degraded" | "live" | "planned" | "retired";
export const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "planned",
  "live",
  "degraded",
  "retired",
];

/** MultiLineString coordinates: lines → positions → [lng, lat]. */
export type RouteCoordinates = number[][][];

export interface Deployment {
  deployedAt: string;
  environment: string;
  id: string;
  lat: number;
  lng: number;
  name: string;
  // Internal-only: present in the record, never in an exported layer —
  // proves the contract exports a chosen subset (comments/notes stay home).
  notes: string;
  owner: string;
  region: string;
  route: RouteCoordinates | null;
  status: DeploymentStatus;
  version: string;
}

export type DeploymentPatch = Partial<Omit<Deployment, "id">>;

export interface LayerRevision {
  revision: number;
  updatedAt: number;
}

interface DeploymentRow {
  deployed_at: string;
  environment: string;
  id: string;
  lat: number;
  lng: number;
  name: string;
  notes: string;
  owner: string;
  region: string;
  route_json: string | null;
  status: DeploymentStatus;
  version: string;
}

interface RevisionRow {
  layer: LayerKey;
  revision: number;
  updated_at: number;
}

// Fields each layer exports. A change to any of them bumps that layer's
// revision; a change touching none (e.g. `notes`) bumps nothing — exactly
// the "is json-data-manager out of date?" signal the manifest carries.
const CENTROID_FIELDS: ReadonlyArray<keyof Deployment> = [
  "deployedAt",
  "environment",
  "lat",
  "lng",
  "name",
  "owner",
  "region",
  "status",
  "version",
];
const ROUTE_FIELDS: ReadonlyArray<keyof Deployment> = ["name", "route", "status"];

function fromRow(row: DeploymentRow): Deployment {
  return {
    deployedAt: row.deployed_at,
    environment: row.environment,
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    name: row.name,
    notes: row.notes,
    owner: row.owner,
    region: row.region,
    route: row.route_json === null ? null : parseRoute(row.route_json),
    status: row.status,
    version: row.version,
  };
}

function parseRoute(json: string): RouteCoordinates {
  const parsed: unknown = JSON.parse(json);
  return isRouteCoordinates(parsed) ? parsed : [];
}

export function isRouteCoordinates(value: unknown): value is RouteCoordinates {
  return (
    Array.isArray(value) &&
    value.every(
      (line) =>
        Array.isArray(line) &&
        line.length >= 2 &&
        line.every(
          (position) =>
            Array.isArray(position) &&
            position.length === 2 &&
            position.every((n) => typeof n === "number" && Number.isFinite(n)),
        ),
    )
  );
}

function toParams(d: Deployment) {
  return {
    deployed_at: d.deployedAt,
    environment: d.environment,
    id: d.id,
    lat: d.lat,
    lng: d.lng,
    name: d.name,
    notes: d.notes,
    owner: d.owner,
    region: d.region,
    route_json: d.route === null ? null : JSON.stringify(d.route),
    status: d.status,
    version: d.version,
  };
}

function changed(before: Deployment, after: Deployment, fields: ReadonlyArray<keyof Deployment>) {
  return fields.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

/** Which layers a write to one deployment makes stale. */
export function layersTouched(before: Deployment | null, after: Deployment | null): LayerKey[] {
  if (before === null || after === null) {
    // Create/delete: the centroid layer always changes; routes only when
    // the created/deleted deployment carries one.
    const subject = before ?? after;
    if (subject === null) {
      return [];
    }
    return subject.route === null ? ["centroids"] : ["centroids", "routes"];
  }
  const touched: LayerKey[] = [];
  if (changed(before, after, CENTROID_FIELDS)) {
    touched.push("centroids");
  }
  const hasRoute = before.route !== null || after.route !== null;
  if (hasRoute && changed(before, after, ROUTE_FIELDS)) {
    touched.push("routes");
  }
  return touched;
}

/** Opaque keyset cursor: the last id served, base64url-encoded. */
function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export class DeploymentStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        region TEXT NOT NULL,
        environment TEXT NOT NULL,
        owner TEXT NOT NULL,
        version TEXT NOT NULL,
        deployed_at TEXT NOT NULL,
        lng REAL NOT NULL,
        lat REAL NOT NULL,
        route_json TEXT,
        notes TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS layer_revisions (
        layer TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO layer_revisions (layer, revision, updated_at)
        VALUES ('centroids', 0, 0), ('routes', 0, 0);
    `);
  }

  /** Replaces every deployment and bumps both layers (a reseed is a change). */
  reset(deployments: Deployment[]): void {
    const insert = this.db.query(
      `INSERT INTO deployments (id, name, status, region, environment, owner, version, deployed_at, lng, lat, route_json, notes)
       VALUES ($id, $name, $status, $region, $environment, $owner, $version, $deployed_at, $lng, $lat, $route_json, $notes)`,
    );
    this.db.transaction(() => {
      this.db.exec("DELETE FROM deployments");
      for (const deployment of deployments) {
        insert.run(toParams(deployment));
      }
      this.bump(LAYER_KEYS);
    })();
  }

  get(id: string): Deployment | null {
    const row = this.db
      .query<DeploymentRow, { id: string }>("SELECT * FROM deployments WHERE id = $id")
      .get({ id });
    return row === null ? null : fromRow(row);
  }

  all(): Deployment[] {
    return this.db
      .query<DeploymentRow, []>("SELECT * FROM deployments ORDER BY id")
      .all()
      .map(fromRow);
  }

  countLayer(layer: LayerKey): number {
    const where = layer === "routes" ? "WHERE route_json IS NOT NULL" : "";
    const row = this.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM deployments ${where}`)
      .get();
    return row === null ? 0 : row.n;
  }

  /**
   * One keyset page of a layer, ordered by the immutable id — so a drain
   * sees every row that existed throughout exactly once, whatever writes
   * land between pages. `cursor: null` only once the layer is exhausted.
   */
  page(
    layer: LayerKey,
    cursor: string | null,
    limit: number,
  ): { cursor: string | null; rows: Deployment[] } {
    const after = cursor === null ? "" : decodeCursor(cursor);
    const routeFilter = layer === "routes" ? "AND route_json IS NOT NULL" : "";
    const rows = this.db
      .query<DeploymentRow, { after: string; limit: number }>(
        `SELECT * FROM deployments WHERE id > $after ${routeFilter} ORDER BY id LIMIT $limit`,
      )
      .all({ after, limit: limit + 1 })
      .map(fromRow);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      cursor: hasMore && last !== undefined ? encodeCursor(last.id) : null,
      rows: pageRows,
    };
  }

  revisions(): Record<LayerKey, LayerRevision> {
    const rows = this.db.query<RevisionRow, []>("SELECT * FROM layer_revisions").all();
    const result: Record<LayerKey, LayerRevision> = {
      centroids: { revision: 0, updatedAt: 0 },
      routes: { revision: 0, updatedAt: 0 },
    };
    for (const row of rows) {
      result[row.layer] = { revision: row.revision, updatedAt: row.updated_at };
    }
    return result;
  }

  insert(deployment: Deployment): LayerKey[] {
    const touched = layersTouched(null, deployment);
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO deployments (id, name, status, region, environment, owner, version, deployed_at, lng, lat, route_json, notes)
           VALUES ($id, $name, $status, $region, $environment, $owner, $version, $deployed_at, $lng, $lat, $route_json, $notes)`,
        )
        .run(toParams(deployment));
      this.bump(touched);
    })();
    return touched;
  }

  /** Applies a patch; returns the layers it made stale, or null when the id is unknown. */
  update(id: string, patch: DeploymentPatch): LayerKey[] | null {
    const before = this.get(id);
    if (before === null) {
      return null;
    }
    const after: Deployment = { ...before, ...patch, id };
    const touched = layersTouched(before, after);
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE deployments SET name = $name, status = $status, region = $region, environment = $environment,
             owner = $owner, version = $version, deployed_at = $deployed_at, lng = $lng, lat = $lat,
             route_json = $route_json, notes = $notes
           WHERE id = $id`,
        )
        .run(toParams(after));
      this.bump(touched);
    })();
    return touched;
  }

  remove(id: string): LayerKey[] | null {
    const before = this.get(id);
    if (before === null) {
      return null;
    }
    const touched = layersTouched(before, null);
    this.db.transaction(() => {
      this.db.query("DELETE FROM deployments WHERE id = $id").run({ id });
      this.bump(touched);
    })();
    return touched;
  }

  close(): void {
    this.db.close();
  }

  private bump(layers: readonly LayerKey[]): void {
    const statement = this.db.query(
      "UPDATE layer_revisions SET revision = revision + 1, updated_at = $now WHERE layer = $layer",
    );
    const now = Date.now();
    for (const layer of layers) {
      statement.run({ layer, now });
    }
  }
}
