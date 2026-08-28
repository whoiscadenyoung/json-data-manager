"use client";

// Provider + context
export { JsonCmsProvider, useJsonCmsApi } from "./provider.js";

// Hooks
export {
  useSchemas,
  useSchema,
  useEntries,
  useEntry,
  useCreateSchema,
  useUpdateSchema,
  useDeleteSchema,
  useCreateEntry,
  useCreateEntriesBulk,
  useUpdateEntry,
  useDeleteEntry,
  useDeleteEntriesBySchema,
} from "./hooks.js";

// Types
export type { JsonCmsApi, SchemaDoc, EntryDoc } from "./types.js";
export type { SchemaId, EntryId } from "../client/index.js";

// Framework-agnostic utilities
export { inferSchemaFromData } from "./lib/infer-schema.js";
export {
  createDefaultUiSchema,
  mergeUiSchemas,
  DEFAULT_SUBMIT_BUTTON_OPTIONS,
} from "./lib/ui-schema.js";
export type {
  UiSchema,
  UiOptions,
  UiSchemaSubmitButtonOptions,
} from "./lib/ui-schema.js";
