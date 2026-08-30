import { describe, expect, test } from "vitest";
import { inferSchemaFromData } from "./infer-schema.js";
import { parseDataRows } from "./parse-data.js";

describe("inferSchemaFromData", () => {
  test("infers primitive types across rows", () => {
    const schema = inferSchemaFromData([
      { name: "Ada", age: 36 },
      { name: "Alan", age: 41 },
    ]);
    const props = schema.properties as Record<string, { type: unknown }>;
    expect(props.name.type).toBe("string");
    expect(props.age.type).toBe("integer");
    expect(schema.required).toEqual(expect.arrayContaining(["name", "age"]));
  });

  test("integer + number merges to number", () => {
    const schema = inferSchemaFromData([{ n: 1 }, { n: 2.5 }]);
    const props = schema.properties as Record<string, { type: unknown }>;
    expect(props.n.type).toBe("number");
  });

  test("null + string produces a nullable union (the reported bug)", () => {
    const schema = inferSchemaFromData([
      { nickname: "Ada" },
      { nickname: null },
      { nickname: "Alan" },
    ]);
    const props = schema.properties as Record<string, { type: unknown }>;
    expect(props.nickname.type).toEqual(["string", "null"]);
    // A field that is null in some rows must NOT be required.
    expect(schema.required ?? []).not.toContain("nickname");
  });

  test("required only lists keys present and non-null in every row", () => {
    const schema = inferSchemaFromData([
      { a: 1, b: 2 },
      { a: 1 }, // b missing
    ]);
    expect(schema.required).toEqual(["a"]);
  });

  test("recurses into nested objects", () => {
    const schema = inferSchemaFromData([
      { addr: { city: "NYC", zip: "10001" } },
      { addr: { city: "LA", zip: "90001" } },
    ]);
    const props = schema.properties as Record<string, { type: unknown; properties: Record<string, { type: unknown }> }>;
    expect(props.addr.type).toBe("object");
    expect(props.addr.properties.city.type).toBe("string");
  });

  test("nested object that is sometimes null becomes nullable", () => {
    const schema = inferSchemaFromData([
      { addr: { city: "NYC" } },
      { addr: null },
    ]);
    const props = schema.properties as Record<string, { type: unknown }>;
    expect(props.addr.type).toEqual(["object", "null"]);
  });

  test("infers array item type", () => {
    const schema = inferSchemaFromData([{ tags: ["a", "b"] }, { tags: ["c"] }]);
    const props = schema.properties as Record<string, { type: unknown; items: { type: unknown } }>;
    expect(props.tags.type).toBe("array");
    expect(props.tags.items.type).toBe("string");
  });

  test("array with null items produces nullable item type", () => {
    const schema = inferSchemaFromData([{ tags: ["a", null, "b"] }]);
    const props = schema.properties as Record<string, { items: { type: unknown } }>;
    expect(props.tags.items.type).toEqual(["string", "null"]);
  });

  test("integrates with parseDataRows over JSONL", () => {
    const { rows } = parseDataRows('{"v":null}\n{"v":"x"}\n{"v":"y"}');
    const schema = inferSchemaFromData(rows);
    const props = schema.properties as Record<string, { type: unknown }>;
    expect(props.v.type).toEqual(["string", "null"]);
  });
});
