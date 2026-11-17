import { relationEndsOf, relationPhrase } from "#/lib/relation-phrases";
import * as layersStore from "#/lib/store/layers";
import type { LayerRow } from "#/lib/store/layers";
import * as mapsStore from "#/lib/store/maps";
import type { MapPlacementRow } from "#/lib/store/maps";
import type { DatasetRelationRow } from "#/lib/store/relations";

/** The name prefix marking a group the related-set feature minted (#342) — "Ungroup" offers only on these. */
export const RELATED_SET_PREFIX = "Related set: ";

/**
 * #342: places a new group holding exactly these layers and REMOVES their
 * top-level placements, so each layer draws once (inside the group).
 * Reversible — "Ungroup" re-places the owned children and deletes the group
 * (its child links cascade with it).
 */
export async function groupRelatedLayers(args: {
  layers: ReadonlyArray<{ layerId: string; placementId: string }>;
  mapId: string;
  name: string;
  projectId: string;
}): Promise<void> {
  const groupId = await layersStore.create({
    kind: "group",
    name: args.name,
    projectId: args.projectId,
  });
  if (groupId === null) {
    throw new Error("The group didn't mint — you may not have access.");
  }
  const membershipRow = await layersStore.membershipIdForLayer({ layerId: groupId });
  if (membershipRow === null) {
    throw new Error("The group's membership didn't mint.");
  }
  const placement = await mapsStore.addPlacement({
    layerMemberId: membershipRow,
    mapId: args.mapId,
  });
  if (placement === null) {
    throw new Error("The group's placement was denied.");
  }
  for (const node of args.layers) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each child links in order; a denial must stop before placements move.
    const child = await layersStore.addChild({
      childKind: "owned",
      childLayerId: node.layerId,
      groupId,
    });
    if (child === null) {
      throw new Error("A layer was denied into the group — nothing moved.");
    }
  }
  // Children linked: the old placements go, so nothing draws twice.
  for (const node of args.layers) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete per former placement, in order.
    await mapsStore.removePlacement({ placementId: node.placementId });
  }
}

/** #342's undo: re-place the group's owned children, drop the group's placement, delete the (now link-less) group. */
export async function ungroupRelatedLayers(args: {
  groupId: string;
  mapId: string;
  placementId: string;
}): Promise<void> {
  const children = await layersStore.listChildren({ groupId: args.groupId });
  for (const child of children) {
    if (child.childKind !== "owned") {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- one placement per restored child, in child order.
    const membershipRow = await layersStore.membershipIdForLayer({ layerId: child.childLayerId });
    if (membershipRow !== null) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
      await mapsStore.addPlacement({ layerMemberId: membershipRow, mapId: args.mapId });
    }
  }
  await mapsStore.removePlacement({ placementId: args.placementId });
  await layersStore.remove({ layerId: args.groupId });
}

/** The placed owned-data layers for exactly `wanted` datasets (#342): the grouping proposal's participants, or undefined when fewer than two qualify. */
export function relatedLayerNodesOf(
  placements: readonly MapPlacementRow[],
  memberships: globalThis.Map<string, layersStore.ArtifactRefRow>,
  layersById: globalThis.Map<string, LayerRow>,
  wantedIds: readonly string[],
): Array<{ layerId: string; name: string; placementId: string }> | undefined {
  if (wantedIds.length < 2) {
    return undefined;
  }
  const wanted = new Set(wantedIds),
    nodes: Array<{ layerId: string; name: string; placementId: string }> = [];
  for (const placement of placements) {
    const membership = memberships.get(placement.layerMemberId),
      layer =
        membership !== undefined && membership.role === "owned"
          ? layersById.get(membership.artifactId)
          : undefined,
      datasetMember =
        layer === undefined || layer.datasetMemberId === null
          ? undefined
          : memberships.get(layer.datasetMemberId);
    if (
      layer === undefined ||
      datasetMember === undefined ||
      datasetMember.artifactKind !== "dataset" ||
      !wanted.has(datasetMember.artifactId)
    ) {
      continue;
    }
    nodes.push({ layerId: layer.id, name: layer.name, placementId: placement.id });
  }
  return nodes.length >= 2 ? nodes : undefined;
}

/** The datasets the map's placed owned data layers draw (groups' children and linked layers aside). */
export function mapDatasetIdsOf(
  placements: readonly MapPlacementRow[],
  memberships: globalThis.Map<string, layersStore.ArtifactRefRow>,
  layersById: globalThis.Map<string, LayerRow>,
): string[] {
  const ids = new Set<string>();
  for (const placement of placements) {
    const membership = memberships.get(placement.layerMemberId),
      layer =
        membership !== undefined && membership.role === "owned"
          ? layersById.get(membership.artifactId)
          : undefined,
      datasetMember =
        layer === undefined || layer.datasetMemberId === null
          ? undefined
          : memberships.get(layer.datasetMemberId);
    if (datasetMember !== undefined && datasetMember.artifactKind === "dataset") {
      ids.add(datasetMember.artifactId);
    }
  }
  return [...ids].toSorted();
}

/** Per dataset on the map, the phrases naming the other map datasets it relates to (#294). */
export function relationNotesOf(
  relations: readonly DatasetRelationRow[],
  datasetIds: readonly string[],
  titleOf: (id: string) => string,
): globalThis.Map<string, string[]> {
  const onMap = new Set(datasetIds),
    notes = new globalThis.Map<string, string[]>();
  for (const id of datasetIds) {
    const phrases = relationEndsOf(relations, id, onMap).map((end) => relationPhrase(end, titleOf));
    if (phrases.length > 0) {
      notes.set(id, phrases);
    }
  }
  return notes;
}
