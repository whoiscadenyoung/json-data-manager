import { describe, expect, it, vi } from "vitest";

// The lib's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any lib import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { postgrestError, stubSupabase, type ScriptedResponse } from "#/lib/store/test-support";

import { mintPublishKey, publishPgDatasetVersion } from "./pg-publish";

describe("mintPublishKey", () => {
  it("mints a UUID-shaped idempotency key (design §5.4)", () => {
    expect(mintPublishKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("publishPgDatasetVersion", () => {
  it("freezes through publish_version carrying label + publish key, and flips a draft", async () => {
    const stub = stubSupabase((query): ScriptedResponse => {
      if (query.rpc === "publish_version") {
        return { data: "version-9" };
      }
      if (query.table === "datasets") {
        return { data: [{ id: "dataset-1" }] };
      }
      return { data: null };
    });
    const outcome = await publishPgDatasetVersion(
      {
        datasetId: "dataset-1",
        isDraft: true,
        publishKey: "key-123",
        versionLabel: "v1",
      },
      { supabase: stub.client },
    );
    expect(outcome).toEqual({ draftFlipped: true, versionId: "version-9" });
    const rpc = stub.queries.find((candidate) => candidate.rpc === "publish_version");
    expect(rpc === undefined ? undefined : rpc.rpcArgs).toEqual({
      p_dataset: "dataset-1",
      p_lineage: null,
      p_publish_key: "key-123",
      p_version_label: "v1",
    });
    // The flip rides the store's lifecycle write (one datasets UPDATE).
    expect(
      stub.queries.some(
        (candidate) =>
          candidate.table === "datasets" &&
          candidate.operations.some((op) => op.method === "update"),
      ),
    ).toBe(true);
  });

  it("skips the lifecycle flip for an already-published dataset", async () => {
    const stub = stubSupabase((query): ScriptedResponse => {
      if (query.rpc === "publish_version") {
        return { data: "version-9" };
      }
      return { data: null };
    });
    const outcome = await publishPgDatasetVersion(
      {
        datasetId: "dataset-1",
        isDraft: false,
        publishKey: "key-123",
        versionLabel: "v2",
      },
      { supabase: stub.client },
    );
    expect(outcome).toEqual({ draftFlipped: false, versionId: "version-9" });
    expect(stub.queries.filter((candidate) => candidate.table === "datasets")).toHaveLength(0);
  });

  it("reports draftFlipped false when the flip moved zero rows (the honest-denial shape)", async () => {
    const stub = stubSupabase((query): ScriptedResponse => {
      if (query.rpc === "publish_version") {
        return { data: "version-9" };
      }
      // The RLS-filtered UPDATE: no visible row matched.
      return { data: [] };
    });
    const outcome = await publishPgDatasetVersion(
      {
        datasetId: "dataset-1",
        isDraft: true,
        publishKey: "key-123",
        versionLabel: "v1",
      },
      { supabase: stub.client },
    );
    expect(outcome.draftFlipped).toBe(false);
    expect(outcome.versionId).toBe("version-9");
  });

  it("throws when the RPC returns no version (a null/empty id is a failed publish, never a success)", async () => {
    const stub = stubSupabase(() => ({ data: null }));
    await expect(
      publishPgDatasetVersion(
        {
          datasetId: "dataset-1",
          isDraft: false,
          publishKey: "key-123",
          versionLabel: "v1",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow(/no version id/);
  });

  it("passes lineage through to the RPC when given", async () => {
    const stub = stubSupabase((query): ScriptedResponse => {
      if (query.rpc === "publish_version") {
        return { data: "version-9" };
      }
      return { data: null };
    });
    await publishPgDatasetVersion(
      {
        datasetId: "dataset-1",
        isDraft: false,
        lineage: { recipe: { kind: "import" }, sourceVersions: [] },
        publishKey: "key-123",
        versionLabel: "v1",
      },
      { supabase: stub.client },
    );
    const rpc = stub.queries.find((candidate) => candidate.rpc === "publish_version");
    expect(rpc === undefined ? undefined : rpc.rpcArgs.p_lineage).toEqual({
      recipe: { kind: "import" },
      sourceVersions: [],
    });
  });

  it("denies the freeze BEFORE any lifecycle move (a locked dataset answers only its creator)", async () => {
    const stub = stubSupabase((query): ScriptedResponse => {
      if (query.rpc === "publish_version") {
        return { error: postgrestError("new row violates row-level security policy") };
      }
      return { data: null };
    });
    await expect(
      publishPgDatasetVersion(
        {
          datasetId: "dataset-1",
          isDraft: true,
          publishKey: "key-123",
          versionLabel: "v1",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow(/row-level security/);
    // No flip write ever ran.
    expect(stub.queries.filter((candidate) => candidate.table === "datasets")).toHaveLength(0);
  });
});
