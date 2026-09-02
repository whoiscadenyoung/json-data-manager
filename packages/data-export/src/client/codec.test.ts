/// <reference types="vite/client" />

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";

import { decodeExportText, defineExportCodec, extractSchemas } from "./index.js";

describe("export codec + helpers", () => {
  const codec = defineExportCodec({
    current: v.object({ email: v.string(), fullName: v.string() }),
    upcasters: {
      // A snapshot written under "v0" only had `name`.
      v0: (doc: { email: string; name: string }) => ({
        email: doc.email,
        fullName: doc.name,
      }),
    },
  });

  test("applies the upcaster matching the snapshot version", () => {
    const decoded = codec.decode({ email: "a@x.com", name: "Ada L" }, "v0");
    expect(decoded).toEqual({ email: "a@x.com", fullName: "Ada L" });
  });

  test("passes rows through unchanged when no upcaster matches", () => {
    const row = { email: "g@x.com", fullName: "Grace H" };
    expect(codec.decode(row, "v1")).toEqual(row);
    expect(codec.decode(row, null)).toEqual(row);
  });

  test("decodeExportText parses JSONL and applies the codec", () => {
    const text =
      JSON.stringify({ email: "a@x.com", name: "Ada" }) +
      "\n" +
      JSON.stringify({ email: "b@x.com", name: "Bo" }) +
      "\n";
    const rows = decodeExportText(text, "v0", codec);
    expect(rows).toEqual([
      { email: "a@x.com", fullName: "Ada" },
      { email: "b@x.com", fullName: "Bo" },
    ]);
  });

  test("extractSchemas pulls validator JSON for the requested tables", () => {
    const schema = defineSchema({
      users: defineTable({ name: v.string() }),
      posts: defineTable({ title: v.string() }),
    });
    const schemas = extractSchemas(schema, ["users", "missing"]);
    expect(Object.keys(schemas)).toEqual(["users"]);
    expect(schemas.users).toMatchObject({ type: "object" });
  });
});
