// One-off measurement for issue #305: a live view's read cost at a realistic
// size (5k point rows with geometry), against the saved-row path.
// Usage (from app/): DATABASE_URL=postgresql://… bun run scripts/measure-live.ts
import { performance } from "node:perf_hooks";

import { defaultViewCompiler } from "../src/lib/views/view-compiler-wiring";
import { connect } from "../src/server/views/entry.server";
import { readLiveAs, setRefreshModeAs } from "../src/server/views/refresh";
import { runViewAs, type RunnerDeps } from "../src/server/views/runner";

const url = process.env["DATABASE_URL"];
if (url === undefined) throw new Error("DATABASE_URL");
const ROWS = Number(process.env["ROWS"] ?? 5000);
const ALICE = "a0000000-0000-4000-8000-000000000001";
const sql = connect(url, 2);

function firstId(rows: readonly Record<string, unknown>[]): string {
  const row = rows[0];
  if (row === undefined || typeof row["id"] !== "string") throw new Error("no id returned");
  return row["id"];
}

const input = firstId(
  await sql.unsafe(
    `insert into public.datasets (title, created_by, lifecycle, visibility)
     values ('measure input', $1, 'published', 'signed-in') returning id`,
    [ALICE],
  ),
);
await sql.unsafe(
  `insert into public.entries (dataset_id, data)
   select $1, jsonb_build_object('name', 'site ' || g, 'state', 'S' || (g % 50), 'cost', g * 1.5,
                                 'active', (g % 2 = 0), 'note', repeat('x', 40))
   from generate_series(1, $2::int) g`,
  [input, ROWS],
);
await sql.unsafe(
  `update public.datasets set properties = '["name","state","cost","active","note"]'::jsonb where id = $1`,
  [input],
);
await sql.unsafe(
  `insert into public.geometries (dataset_id, entry_id, source, type)
   select dataset_id, id,
          jsonb_build_object('type','Point','coordinates', jsonb_build_array(-120 + random()*50, 25 + random()*20)),
          'Point'
   from public.entries where dataset_id = $1`,
  [input],
);

const definition = {
  inputs: [{ alias: "sites", ref: { kind: "dataset", id: input } }],
  base: "sites",
  steps: [],
  output: { fields: [], emptyFields: "keep" },
};
const viewId = firstId(
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [JSON.stringify({ sub: ALICE, role: "authenticated" }), ALICE],
    );
    return await tx.unsafe(
      `select public.create_view('measure view', $1::jsonb, $2::jsonb, 'manual', null, 'published', 'signed-in', 'open') as id`,
      [JSON.stringify(definition), JSON.stringify([{ alias: "sites", datasetId: input }])],
    );
  }),
);

const who = {
  sub: ALICE,
  role: "authenticated" as const,
  claims: { sub: ALICE, role: "authenticated" },
};
const deps: RunnerDeps = {
  sql,
  compiler: defaultViewCompiler,
  timeoutMs: 60_000,
  liveRowCap: 100_000,
};

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await work();
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return out;
}

try {
  await setRefreshModeAs(deps, who, viewId, "live");
  const reads: number[] = [];
  let bytes = 0;
  let count = 0;
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const read = await readLiveAs(deps, who, viewId);
    reads.push(performance.now() - t0);
    bytes = JSON.stringify(read.rows).length;
    count = read.rows.length;
  }
  console.log(
    `live read (${count} of ${ROWS} rows, ${(bytes / 1e6).toFixed(2)} MB JSON): ` +
      reads.map((ms) => `${ms.toFixed(0)}ms`).join(", "),
  );
  // The saved-row comparison: what a snapshot run costs (the write side).
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [JSON.stringify({ sub: ALICE, role: "authenticated" }), ALICE],
    );
    await tx.unsafe(`select public.set_view_refresh_mode($1::uuid, 'manual')`, [viewId]);
  });
  await timed("snapshot run (saves rows)", async () => await runViewAs(deps, who, viewId));
} finally {
  await sql.unsafe(`delete from public.datasets where id = $1`, [viewId]);
  await sql
    .unsafe(`delete from public.entries where dataset_id = $1`, [input])
    .catch(() => undefined);
  await sql.unsafe(`delete from public.datasets where id = $1`, [input]).catch(() => undefined);
  await sql.end({ timeout: 2 });
}
