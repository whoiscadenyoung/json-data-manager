import type { OutputSchema } from "@caden/data-core/views";
import { useQueries } from "@tanstack/react-query";

import { savedDefinitionQueryOptions } from "#/lib/store/view-reads";

/**
 * Popup (tooltip) fields of a layer (issue #303). A layer over a VIEW shows
 * the view's labels and order ("from view") unless the layer carries its own
 * override. The override is stored in the layer's `popup` jsonb as
 * `{ fields: [{ key, label? }] }`; `popup = null` is the "from view" default,
 * which is also what "reset" writes. Hidden output fields never show.
 */

export interface PopupField {
  key: string;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The layer's own override list, or `undefined` when it follows the view. */
export function popupOverrideOf(popup: unknown): PopupField[] | undefined {
  if (!isRecord(popup) || !Array.isArray(popup["fields"])) {
    return undefined;
  }
  const out: PopupField[] = [];
  for (const item of popup["fields"]) {
    if (isRecord(item) && typeof item["key"] === "string") {
      const label = item["label"];
      out.push({
        key: item["key"],
        label: typeof label === "string" && label !== "" ? label : item["key"],
      });
    }
  }
  return out;
}

/** The view's popup fields: visible output fields in order, labelled. Empty list of fields = no preference. */
export function popupFieldsFromView(output: OutputSchema | undefined): PopupField[] | undefined {
  if (output === undefined || output.fields.length === 0) {
    return undefined;
  }
  return output.fields
    .filter((field) => field.hidden !== true)
    .map((field) => ({
      key: field.key,
      label: field.label !== undefined && field.label !== "" ? field.label : field.key,
    }));
}

/** An override wins; otherwise the view's fields; `undefined` shows every property as before. */
export function resolvePopupFields(
  popup: unknown,
  output: OutputSchema | undefined,
): PopupField[] | undefined {
  return popupOverrideOf(popup) ?? popupFieldsFromView(output);
}

export function outputOfDefinition(saved: unknown): OutputSchema | undefined {
  if (!isRecord(saved) || !isRecord(saved["definition"])) {
    return undefined;
  }
  return outputSchemaOf(saved["definition"]["output"]);
}

/** A raw output jsonb ({fields: [...]}) as an OutputSchema — the shape both the saved view definition and the app-snapshot stamp carry. */
export function outputSchemaOf(value: unknown): OutputSchema | undefined {
  if (!isRecord(value) || !Array.isArray(value["fields"])) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the output was validated on save/publish; only its shape is read here.
  return value as unknown as OutputSchema;
}

/** A raw ViewDefinition's output block (the `datasets.definition` column shape the publish walks read). */
export function outputOfViewDefinition(definition: unknown): OutputSchema | undefined {
  if (!isRecord(definition)) {
    return undefined;
  }
  return outputSchemaOf(definition["output"]);
}

export interface PopupLayerInput {
  renderId: string;
  /** The layer's stored `popup` jsonb (owned layers only). */
  popup: unknown;
}

/**
 * `renderId -> popup fields` for the map's layers. Only datasets that are
 * views (`viewIds`) read a saved definition; others keep every property.
 */
export function usePopupFieldsFor(
  layers: readonly PopupLayerInput[],
  viewIds: ReadonlySet<string>,
): (renderId: string) => PopupField[] | undefined {
  const ids = [...new Set(layers.map((layer) => layer.renderId))].filter((id) => viewIds.has(id));
  const results = useQueries({
    queries: ids.map((id) => savedDefinitionQueryOptions(id)),
  });
  const outputById = new Map<string, OutputSchema | undefined>(
    ids.map((id, index) => {
      const result = results[index];
      return [id, outputOfDefinition(result === undefined ? undefined : result.data)];
    }),
  );
  return (renderId) => {
    const layer = layers.find((candidate) => candidate.renderId === renderId);
    return resolvePopupFields(
      layer === undefined ? undefined : layer.popup,
      outputById.get(renderId),
    );
  };
}

/** The map's data entries with their layers' stored popup config (linked entries have none). */
export function popupInputsOf(
  entries: readonly { renderId: string; layerId?: string }[],
  layersById: ReadonlyMap<string, { popup: unknown }>,
): PopupLayerInput[] {
  return entries.map((entry) => {
    const layer = entry.layerId === undefined ? undefined : layersById.get(entry.layerId);
    return { renderId: entry.renderId, popup: layer === undefined ? undefined : layer.popup };
  });
}
