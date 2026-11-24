// Moves storage objects between a stack and a snapshot directory through the
// storage-api REST interface (so it works against any backend and any
// deployment, local or VPS).
//
//   bun scripts/seed/storage.ts pull <manifest.json> <outDir>
//   bun scripts/seed/storage.ts push <manifest.json> <inDir>
//
// Env: STORAGE_URL (e.g. http://localhost:8000/storage/v1), SERVICE_ROLE_KEY.
// Manifest: [{ bucket, name, mimetype }]. Files land at <dir>/<bucket>/<name>.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Item = { bucket: string; name: string; mimetype: string | null };

const [mode, manifestPath, dir] = Bun.argv.slice(2);
const base = process.env.STORAGE_URL;
const key = process.env.SERVICE_ROLE_KEY;
if ((mode !== "pull" && mode !== "push") || !manifestPath || !dir || !base || !key) {
  console.error(
    "usage: storage.ts pull|push <manifest.json> <dir>  (env: STORAGE_URL, SERVICE_ROLE_KEY)",
  );
  process.exit(2);
}

const headers = { Authorization: `Bearer ${key}`, apikey: key };
const objectUrl = (i: Item) =>
  `${base}/object/${i.bucket}/${i.name.split("/").map(encodeURIComponent).join("/")}`;

const items: Item[] = JSON.parse(await readFile(manifestPath, "utf8"));
let done = 0;
let bytes = 0;

async function transfer(item: Item) {
  const path = join(dir, item.bucket, item.name);
  if (mode === "pull") {
    const res = await fetch(objectUrl(item), { headers });
    if (!res.ok)
      throw new Error(`GET ${item.bucket}/${item.name}: ${res.status} ${await res.text()}`);
    await mkdir(dirname(path), { recursive: true });
    bytes += await Bun.write(path, res);
  } else {
    const file = Bun.file(path);
    const res = await fetch(objectUrl(item), {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": item.mimetype ?? "application/octet-stream",
        "x-upsert": "true",
      },
      body: file,
    });
    if (!res.ok)
      throw new Error(`POST ${item.bucket}/${item.name}: ${res.status} ${await res.text()}`);
    bytes += file.size;
  }
  done += 1;
  if (done % 20 === 0 || done === items.length) {
    console.log(`[storage] ${mode} ${done}/${items.length} (${(bytes / 1e6).toFixed(0)} MB)`);
  }
}

// small fixed-width worker pool
const queue = [...items];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await transfer(item);
  }),
);
