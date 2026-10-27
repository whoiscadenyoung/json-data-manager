import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { generateDeployments } from "./generate";
import { startServer } from "./server";
import { DeploymentStore, layersTouched } from "./store";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let store: DeploymentStore;
let server: ReturnType<typeof startServer>;

function url(path: string): string {
  return new URL(path, server.url).href;
}

async function getJson(path: string): Promise<any> {
  const response = await fetch(url(path), { headers: AUTH });
  expect(response.status).toBe(200);
  return response.json();
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(url(path), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...AUTH, "content-type": "application/json" },
    method,
  });
}

async function drain(layer: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = cursor === null ? "" : `&cursor=${cursor}`;
    // oxlint-disable-next-line no-await-in-loop -- draining a cursor is inherently sequential.
    const page = await getJson(`/layers/${layer}/rows?limit=${limit}${query}`);
    ids.push(...page.features.map((feature: { id: string }) => feature.id));
    cursor = page.cursor;
    pages += 1;
  } while (cursor !== null);
  return { ids, pages };
}

beforeEach(() => {
  store = new DeploymentStore(":memory:");
  store.reset(generateDeployments(50, 7));
  server = startServer({
    fixture: { count: 50, seed: 7 },
    port: 0,
    publicUrl: "http://demo.test",
    store,
    token: TOKEN,
  });
});

afterEach(async () => {
  await server.stop(true);
  store.close();
});

describe("auth", () => {
  test("contract routes reject a missing or wrong token", async () => {
    expect((await fetch(url("/manifest"))).status).toBe(401);
    expect(
      (await fetch(url("/layers/centroids/rows"), { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
  });
});

describe("manifest", () => {
  test("describes both layers with counts and revisions", async () => {
    const manifest = await getJson("/manifest");
    expect(manifest.layers.map((layer: { key: string }) => layer.key)).toEqual([
      "centroids",
      "routes",
    ]);
    const [centroids, routes] = manifest.layers;
    expect(centroids.geometryType).toBe("Point");
    expect(centroids.featureCount).toBe(50);
    expect(routes.geometryType).toBe("MultiLineString");
    expect(routes.featureCount).toBe(store.countLayer("routes"));
    expect(routes.featureCount).toBeGreaterThan(0);
    expect(centroids.revision).toBe(1);
    expect(manifest.recordUrlTemplate).toBe("http://demo.test/deployments/{key}");
  });
});

describe("rows", () => {
  test("a small-page drain returns every centroid exactly once", async () => {
    const { ids, pages } = await drain("centroids", 7);
    expect(pages).toBe(8);
    expect(new Set(ids).size).toBe(50);
  });

  test("routes layer only carries deployments with a route, keyed by deployment id", async () => {
    const page = await getJson("/layers/routes/rows?limit=1000");
    expect(page.type).toBe("FeatureCollection");
    expect(page.features.length).toBe(store.countLayer("routes"));
    for (const feature of page.features) {
      expect(feature.geometry.type).toBe("MultiLineString");
      expect(feature.properties.deploymentId).toBe(feature.id);
    }
  });

  test("exports never include internal notes", async () => {
    const page = await getJson("/layers/centroids/rows?limit=5");
    for (const feature of page.features) {
      expect(feature.properties).not.toHaveProperty("notes");
    }
  });

  test("unknown layer is a 404", async () => {
    expect((await fetch(url("/layers/nope/rows"), { headers: AUTH })).status).toBe(404);
  });
});

describe("revisions", () => {
  test("a notes-only edit bumps nothing; a move bumps centroids only", async () => {
    const [first] = store.all();
    if (first === undefined) {
      throw new Error("fixture is empty");
    }
    const before = store.revisions();
    expect((await send("PATCH", `/admin/deployments/${first.id}`, { notes: "x" })).status).toBe(
      200,
    );
    expect(store.revisions()).toEqual(before);

    await send("PATCH", `/admin/deployments/${first.id}`, { lat: first.lat + 0.1 });
    const after = store.revisions();
    expect(after.centroids.revision).toBe(before.centroids.revision + 1);
    expect(after.routes.revision).toBe(before.routes.revision);
  });

  test("status change on a routed deployment bumps both layers", () => {
    const routed = store.all().find((deployment) => deployment.route !== null);
    if (routed === undefined) {
      throw new Error("fixture has no routed deployment");
    }
    expect(
      layersTouched(routed, {
        ...routed,
        status: "retired" === routed.status ? "live" : "retired",
      }),
    ).toEqual(["centroids", "routes"]);
  });

  test("adding a route touches only the routes layer", () => {
    const plain = store.all().find((deployment) => deployment.route === null);
    if (plain === undefined) {
      throw new Error("fixture has no plain deployment");
    }
    expect(
      layersTouched(plain, {
        ...plain,
        route: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toEqual(["routes"]);
  });

  test("invalid patches are rejected", async () => {
    const [first] = store.all();
    if (first === undefined) {
      throw new Error("fixture is empty");
    }
    expect(
      (await send("PATCH", `/admin/deployments/${first.id}`, { status: "bogus" })).status,
    ).toBe(400);
    expect((await send("PATCH", `/admin/deployments/${first.id}`, { color: "red" })).status).toBe(
      400,
    );
  });
});

describe("faults", () => {
  test("failNext returns the configured status, then recovers", async () => {
    await send("PUT", "/admin/faults", { failNext: 1, failStatus: 429 });
    expect((await fetch(url("/manifest"), { headers: AUTH })).status).toBe(429);
    expect((await fetch(url("/manifest"), { headers: AUTH })).status).toBe(200);
  });

  test("truncate ends the drain after one page", async () => {
    await send("PUT", "/admin/faults", { truncate: true });
    const { ids, pages } = await drain("centroids", 10);
    expect(pages).toBe(1);
    expect(ids.length).toBe(10);
  });

  test("malformedNext serves unparseable JSON once", async () => {
    await send("PUT", "/admin/faults", { malformedNext: 1 });
    const response = await fetch(url("/manifest"), { headers: AUTH });
    expect(response.json()).rejects.toThrow();
  });

  test("reset clears faults and restores the fixture", async () => {
    await send("PUT", "/admin/faults", { truncate: true });
    await send("POST", "/admin/churn", { count: 20 });
    expect((await send("POST", "/admin/reset")).status).toBe(200);
    expect(store.countLayer("centroids")).toBe(50);
    expect((await getJson("/admin/faults")).truncate).toBe(false);
  });
});
