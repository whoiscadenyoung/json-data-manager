import { v } from "convex/values";

import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { NATIONAL_PARKS, SYSTEM_VISITS } from "./exampleData";
import type { AppPage } from "./validators";

/**
 * The seeded example apps (docs/app-builder.md "Example apps"): two sample
 * datasets in the catalog and two apps built on them — one contained
 * dashboard, and one with a full-screen map page plus a dashboard page — so
 * a fresh deployment has something to open, learn from, and copy.
 *
 * Run once per deployment (idempotent — a second run is a no-op):
 *
 *   bunx convex run appBuilder/examples:seed
 *
 * After changing the example definitions below, rebuild the example apps
 * in place (the sample datasets are reused when they still exist):
 *
 *   bunx convex run appBuilder/examples:seed '{"replace": true}'
 *
 * Example apps are owned by no user (`createdBy` = EXAMPLES_OWNER, never a
 * Better Auth id), flagged `example`, and readable by everyone signed in;
 * nobody can edit them, everyone can "Make a copy". The sample datasets are
 * published, everyone-visible, and `editPolicy: "locked"` with no creator,
 * so no one can change or delete them through the app (ADR 0010).
 */

/** The `createdBy` of seeded examples — not a user id, so no user is ever their owner. */
export const EXAMPLES_OWNER = "system:examples";

const SAMPLE_NOTE = "Sample data with rounded, approximate values — for exploring the app builder.";

async function createLockedDataset(
  ctx: MutationCtx,
  args: {
    title: string;
    description: string;
    properties: Record<string, { type: string }>;
    geospatial: boolean;
    entries: Array<{ data: Record<string, unknown>; geometry?: string }>;
  },
): Promise<string> {
  const schemaId = await ctx.runMutation(components.jsonCms.schemas.createSchema, {
    ...(args.geospatial ? { geometryType: "Point" as const, kind: "geospatial" as const } : {}),
    schema: {
      description: `${args.description} ${SAMPLE_NOTE}`,
      properties: args.properties,
      title: args.title,
      type: "object",
    },
  });
  await ctx.runMutation(components.jsonCms.entries.createEntriesBulk, {
    entries: args.entries,
    schemaId,
  });
  await ctx.runMutation(components.jsonCms.schemas.setEditPolicy, {
    editPolicy: "locked",
    schemaId,
  });
  return schemaId;
}

async function createSampleDatasets(ctx: MutationCtx) {
  const parks = await createLockedDataset(ctx, {
    description: "U.S. national parks with size, founding year and 2023 recreation visits.",
    entries: NATIONAL_PARKS.map(([name, state, region, established, area, visitors, lng, lat]) => ({
      data: { area_acres: area, established, name, region, state, visitors_millions: visitors },
      geometry: JSON.stringify({ coordinates: [lng, lat], type: "Point" }),
    })),
    geospatial: true,
    properties: {
      area_acres: { type: "number" },
      established: { type: "integer" },
      name: { type: "string" },
      region: { type: "string" },
      state: { type: "string" },
      visitors_millions: { type: "number" },
    },
    title: "Example: National Parks",
  });
  const visits = await createLockedDataset(ctx, {
    description: "Total National Park System recreation visits per year.",
    entries: SYSTEM_VISITS.map(([year, visitsMillions]) => ({
      data: { visits_millions: visitsMillions, year },
    })),
    geospatial: false,
    properties: { visits_millions: { type: "number" }, year: { type: "integer" } },
    title: "Example: Park System Visits by Year",
  });
  return { parks, visits };
}

/** The contained, single-page dashboard. */
function explorerPages(parks: string, visits: string): AppPage[] {
  return [
    {
      id: "overview",
      layout: "contained",
      title: "Overview",
      widgets: [
        {
          body: "## America's national parks\nTwenty-eight parks from Acadia to Gates of the Arctic. Click a point on the map for details.",
          h: 2,
          id: "intro",
          kind: "text",
          w: 12,
        },
        {
          aggregate: "count",
          datasetId: parks,
          h: 2,
          id: "parks",
          kind: "stat",
          title: "Parks",
          w: 4,
        },
        {
          aggregate: "sum",
          datasetId: parks,
          field: "visitors_millions",
          h: 2,
          id: "visits",
          kind: "stat",
          title: "2023 visits (millions)",
          w: 4,
        },
        {
          aggregate: "min",
          datasetId: parks,
          field: "established",
          h: 2,
          id: "oldest",
          kind: "stat",
          title: "Oldest park founded",
          w: 4,
        },
        { datasetIds: [parks], h: 6, id: "map", kind: "map", title: "Where the parks are", w: 8 },
        {
          aggregate: "sum",
          chartType: "donut",
          datasetId: parks,
          groupBy: "region",
          h: 6,
          id: "regions",
          kind: "chart",
          limit: 7,
          sort: "value-desc",
          title: "2023 visits by region (millions)",
          valueField: "visitors_millions",
          w: 4,
        },
        {
          aggregate: "sum",
          chartType: "line",
          datasetId: visits,
          groupBy: "year",
          h: 5,
          id: "per-year",
          kind: "chart",
          limit: 20,
          sort: "label-asc",
          title: "Park system visits per year (millions)",
          valueField: "visits_millions",
          w: 6,
        },
        {
          columns: ["name", "state", "region", "established", "visitors_millions"],
          datasetId: parks,
          h: 5,
          id: "table",
          kind: "table",
          title: "All parks",
          w: 6,
        },
      ],
    },
  ];
}

/** A full-screen map first, then a dashboard tab. */
function atlasPages(parks: string, visits: string): AppPage[] {
  return [
    {
      id: "map",
      layout: "fullscreen",
      title: "Map",
      widgets: [{ datasetIds: [parks], h: 12, id: "atlas-map", kind: "map", w: 12 }],
    },
    {
      id: "dashboard",
      layout: "contained",
      title: "Dashboard",
      widgets: [
        {
          aggregate: "sum",
          datasetId: parks,
          field: "visitors_millions",
          h: 2,
          id: "atlas-visits",
          kind: "stat",
          title: "2023 visits (millions)",
          w: 3,
        },
        {
          aggregate: "sum",
          datasetId: parks,
          field: "area_acres",
          h: 2,
          id: "atlas-area",
          kind: "stat",
          title: "Protected acres",
          w: 3,
        },
        {
          aggregate: "max",
          datasetId: parks,
          field: "established",
          h: 2,
          id: "atlas-newest",
          kind: "stat",
          title: "Newest park founded",
          w: 3,
        },
        {
          aggregate: "count",
          datasetId: parks,
          h: 2,
          id: "atlas-count",
          kind: "stat",
          title: "Parks",
          w: 3,
        },
        {
          aggregate: "sum",
          chartType: "bar",
          datasetId: parks,
          groupBy: "region",
          h: 6,
          id: "atlas-regions",
          kind: "chart",
          limit: 10,
          sort: "value-desc",
          title: "2023 visits by region (millions)",
          valueField: "visitors_millions",
          w: 6,
        },
        {
          aggregate: "sum",
          chartType: "area",
          datasetId: visits,
          groupBy: "year",
          h: 6,
          id: "atlas-trend",
          kind: "chart",
          limit: 20,
          sort: "label-asc",
          title: "Park system visits per year (millions)",
          valueField: "visits_millions",
          w: 6,
        },
      ],
    },
  ];
}

async function insertExample(
  ctx: MutationCtx,
  args: { title: string; description: string; datasetIds: string[]; pages: AppPage[] },
): Promise<Id<"apps">> {
  return ctx.db.insert("apps", {
    ...args,
    createdBy: EXAMPLES_OWNER,
    example: true,
    revision: 0,
    sharing: "link",
    updatedAt: Date.now(),
  });
}

/** The sample datasets an earlier seed created, when both still exist. */
async function existingSampleDatasets(
  ctx: MutationCtx,
  datasetIds: readonly string[],
): Promise<{ parks: string; visits: string } | undefined> {
  const [parks, visits] = datasetIds;
  if (parks === undefined || visits === undefined) {
    return undefined;
  }
  const docs = await Promise.all(
    [parks, visits].map(async (schemaId) =>
      ctx.runQuery(components.jsonCms.schemas.getSchema, { schemaId }),
    ),
  );
  return docs.every((doc) => doc !== null) ? { parks, visits } : undefined;
}

/**
 * Seeds the sample datasets and example apps unless examples already exist
 * (`replace` rebuilds the example apps, reusing the sample datasets).
 * Internal: run it with the deployment's admin key (`bunx convex run`), never
 * from a browser.
 */
export const seed = internalMutation({
  args: { replace: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("apps")
      .withIndex("by_example", (q) => q.eq("example", true))
      .take(10);
    if (existing.length > 0 && args.replace !== true) {
      return { created: false, examples: existing.map((app) => app._id) };
    }
    const reused =
      existing.length > 0 ? await existingSampleDatasets(ctx, existing[0].datasetIds) : undefined;
    await Promise.all(existing.map(async (app) => ctx.db.delete("apps", app._id)));
    const { parks, visits } = reused ?? (await createSampleDatasets(ctx));
    const explorer = await insertExample(ctx, {
      datasetIds: [parks, visits],
      description:
        "A contained, single-page dashboard: headline numbers, a map, charts and a table.",
      pages: explorerPages(parks, visits),
      title: "National Parks Explorer",
    });
    const atlas = await insertExample(ctx, {
      datasetIds: [parks, visits],
      description: "A full-screen map on the first page and a dashboard on the second.",
      pages: atlasPages(parks, visits),
      title: "Park Visits Atlas",
    });
    return { created: true, examples: [explorer, atlas] };
  },
  returns: v.object({ created: v.boolean(), examples: v.array(v.id("apps")) }),
});
