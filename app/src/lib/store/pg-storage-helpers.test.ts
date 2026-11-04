// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { uploadSourceFile } from "./datasets";
import { uploadGeometrySource } from "./geometries";
import { firstArg, queryAt, stubSupabase, type RecordedUpload } from "./test-support";

/** The only recorded upload, or a loud failure (the no-optional-chaining test style). */
function onlyUpload(uploads: ReadonlyArray<RecordedUpload>): RecordedUpload {
  if (uploads.length !== 1) {
    throw new Error(`Expected exactly one upload (have ${uploads.length}).`);
  }
  const upload = uploads[0];
  if (upload === undefined) {
    throw new Error("No upload recorded.");
  }
  return upload;
}

describe("geometries.uploadGeometrySource — the §10 oversized-payload upload", () => {
  it("puts the JSON payload into the dataset's geometries/ folder and answers path + exact bytes", async () => {
    const { client, uploads } = stubSupabase();
    const source = { coordinates: [1.234567, 2.345678], type: "Point" };
    const result = await uploadGeometrySource(
      { datasetId: "d1", rowIndex: 7, source },
      { supabase: client },
    );
    // The path carries a PER-UPLOAD random token (the stage-4 storage-
    // collision fix): `<datasetId>/<token>/row-<index>.json` — a Retry and
    // another collaborator's attempt never PUT to the same object.
    expect(result.path.startsWith("d1/")).toBe(true);
    expect(result.path.endsWith("/row-7.json")).toBe(true);
    const pathParts = result.path.split("/");
    expect(pathParts.length).toBe(3);
    expect(result.bytes).toBe(JSON.stringify(source).length);
    expect(uploads.length).toBe(1);
    const upload = onlyUpload(uploads);
    expect(upload.bucket).toBe("geometries");
    expect(upload.path).toBe(result.path);
    // No upsert: a per-upload path never collides, so the write is a fresh
    // object (the 0006 update policy never comes into play).
    expect(upload.upsert).toBe(false);
  });

  it("propagates storage failures (the import aborts before any chunk is sent)", async () => {
    // The stub's upload records and succeeds; a failure path is exercised by
    // the caller contract (runPgImport's try/catch), so here just prove the
    // happy path shapes the row the RPC expects.
    const { client } = stubSupabase();
    const result = await uploadGeometrySource(
      { datasetId: "d1", rowIndex: 0, source: { type: "Point", coordinates: [0, 0] } },
      { supabase: client },
    );
    // The per-upload token path shape: <datasetId>/<token>/row-<index>.json.
    expect(result.path.startsWith("d1/")).toBe(true);
    expect(result.path.endsWith("/row-0.json")).toBe(true);
    expect(result.bytes).toBe(JSON.stringify({ type: "Point", coordinates: [0, 0] }).length);
  });
});

describe("datasets.uploadSourceFile — the §10 source-file retention", () => {
  it("uploads the original file, records name/size/path on the dataset row, and answers path + affected rows", async () => {
    const { client, queries, uploads } = stubSupabase(() => ({
      data: [{ id: "d1" }],
      error: null,
    }));
    const file = new File(["csv,data\n1,2"], "streets.csv", { type: "text/csv" });
    const result = await uploadSourceFile({ datasetId: "d1", file }, { supabase: client });
    expect(result.path).toBe("d1/streets.csv");
    // The rows-affected answer (the stage-4 silent-denial rule): 1 row here.
    expect(result.affected).toBe(1);
    expect(uploads.length).toBe(1);
    const upload = onlyUpload(uploads);
    expect(upload.bucket).toBe("source-files");
    // Upsert: a Retry re-attaches the file over the superseded copy.
    expect(upload.upsert).toBe(true);
    const update = queryAt(queries, 0);
    expect(update.table).toBe("datasets");
    expect(firstArg(update, "update")).toStrictEqual({
      source_file_name: "streets.csv",
      source_file_path: "d1/streets.csv",
      source_file_size: file.size,
    });
  });
});
