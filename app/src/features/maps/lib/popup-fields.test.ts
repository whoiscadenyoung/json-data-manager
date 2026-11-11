import type { OutputSchema } from "@caden/data-core/views";
import { describe, expect, test, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { popupFieldsFromView, popupOverrideOf, resolvePopupFields } from "./popup-fields";

const OUTPUT: OutputSchema = {
  emptyFields: "keep",
  fields: [
    { key: "name" },
    { key: "deployments", label: "Deployments" },
    { key: "agencyCount", hidden: true },
  ],
};

describe("layer popup fields", () => {
  test("a layer over a view defaults to the view's labels and order, without hidden fields", () => {
    expect(resolvePopupFields(null, OUTPUT)).toEqual([
      { key: "name", label: "name" },
      { key: "deployments", label: "Deployments" },
    ]);
  });

  test("a per-layer override wins, and null resets to the view", () => {
    const override = { fields: [{ key: "deployments", label: "Count" }] };
    expect(resolvePopupFields(override, OUTPUT)).toEqual([{ key: "deployments", label: "Count" }]);
    expect(popupOverrideOf(null)).toBeUndefined();
  });

  test("no output preference shows every property", () => {
    expect(popupFieldsFromView({ fields: [], emptyFields: "keep" })).toBeUndefined();
    expect(resolvePopupFields(null, undefined)).toBeUndefined();
  });
});
