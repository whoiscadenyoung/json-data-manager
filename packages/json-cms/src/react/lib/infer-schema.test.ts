import { describe, expect, it } from "vitest";

import { inferSchemaFromData } from "./infer-schema.js";
import { parseDataRows } from "./parse-data.js";

describe(inferSchemaFromData, () => {
  it("infers primitive types across rows", () => {
    const schema = inferSchemaFromData([
        { age: 36, name: "Ada" },
        { age: 41, name: "Alan" },
      ]),
      props = schema.properties as Record<string, { type: unknown }>;
    expect(props.name.type).toBe("string");
    expect(props.age.type).toBe("integer");
    expect(schema.required).toStrictEqual(expect.arrayContaining(["name", "age"]));
  });

  it("integer + number merges to number", () => {
    const schema = inferSchemaFromData([{ n: 1 }, { n: 2.5 }]),
      props = schema.properties as Record<string, { type: unknown }>;
    expect(props.n.type).toBe("number");
  });

  it("null + string produces a nullable union (the reported bug)", () => {
    const schema = inferSchemaFromData([
        { nickname: "Ada" },
        { nickname: null },
        { nickname: "Alan" },
      ]),
      props = schema.properties as Record<string, { type: unknown }>;
    expect(props.nickname.type).toStrictEqual(["string", "null"]);
    // A field that is null in some rows must NOT be required.
    expect(schema.required ?? []).not.toContain("nickname");
  });

  it("required only lists keys present and non-null in every row", () => {
    const schema = inferSchemaFromData([
      { a: 1, b: 2 },
      { a: 1 }, // B missing
    ]);
    expect(schema.required).toStrictEqual(["a"]);
  });

  it("recurses into nested objects", () => {
    const schema = inferSchemaFromData([
        { addr: { city: "NYC", zip: "10001" } },
        { addr: { city: "LA", zip: "90001" } },
      ]),
      props = schema.properties as Record<
        string,
        { type: unknown; properties: Record<string, { type: unknown }> }
      >;
    expect(props.addr.type).toBe("object");
    expect(props.addr.properties.city.type).toBe("string");
  });

  it("nested object that is sometimes null becomes nullable", () => {
    const schema = inferSchemaFromData([{ addr: { city: "NYC" } }, { addr: null }]),
      props = schema.properties as Record<string, { type: unknown }>;
    expect(props.addr.type).toStrictEqual(["object", "null"]);
  });

  it("infers array item type", () => {
    const schema = inferSchemaFromData([{ tags: ["a", "b"] }, { tags: ["c"] }]),
      props = schema.properties as Record<string, { type: unknown; items: { type: unknown } }>;
    expect(props.tags.type).toBe("array");
    expect(props.tags.items.type).toBe("string");
  });

  it("array with null items produces nullable item type", () => {
    const schema = inferSchemaFromData([{ tags: ["a", null, "b"] }]),
      props = schema.properties as Record<string, { items: { type: unknown } }>;
    expect(props.tags.items.type).toStrictEqual(["string", "null"]);
  });

  it("integrates with parseDataRows over JSONL", () => {
    const { rows } = parseDataRows('{"v":null}\n{"v":"x"}\n{"v":"y"}'),
      schema = inferSchemaFromData(rows),
      props = schema.properties as Record<string, { type: unknown }>;
    expect(props.v.type).toStrictEqual(["string", "null"]);
  });
});
