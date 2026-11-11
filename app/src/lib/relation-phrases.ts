/**
 * Human phrasing of declared dataset relations (issue #294): the catalog
 * badges, the map layer indicators and their peek lists all say the same
 * thing — "Related to FY23 IG Project Corridors via UEI". Pure; reads the
 * same `dataset_relations` rows the lineage graph (#304) draws as dashed
 * edges, so nothing new is stored.
 */
import type { DatasetRelationRow } from "./store/relations";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(config: unknown, key: string): string | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const value = config[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export interface RelationEnd {
  relationId: string;
  /** The dataset at the other end. */
  otherId: string;
  /** "via UEI", "via UEI ↔ Grant_UEI", "by location (intersects)" or "". */
  how: string;
}

/** How the relation joins, read from this dataset's side. */
function howOf(relation: DatasetRelationRow, fromThisSide: boolean): string {
  if (relation.kind === "spatial") {
    const predicate = stringField(relation.config, "predicate");
    return predicate === undefined ? "by location" : `by location (${predicate})`;
  }
  const fromKey = stringField(relation.config, "fromKey"),
    toKey = stringField(relation.config, "toKey"),
    mine = fromThisSide ? fromKey : toKey,
    theirs = fromThisSide ? toKey : fromKey;
  if (mine === undefined || theirs === undefined) {
    return "";
  }
  return mine === theirs ? `via ${mine}` : `via ${mine} ↔ ${theirs}`;
}

/**
 * The relations touching `datasetId`, each from its side. A relation from a
 * dataset to itself appears once. `withinIds` bounds the other end (the
 * map's layers); omit it for every relation.
 */
export function relationEndsOf(
  relations: readonly DatasetRelationRow[],
  datasetId: string,
  withinIds?: ReadonlySet<string>,
): RelationEnd[] {
  const ends: RelationEnd[] = [];
  for (const relation of relations) {
    const fromThisSide = relation.fromDataset === datasetId;
    if (!fromThisSide && relation.toDataset !== datasetId) {
      continue;
    }
    const otherId = fromThisSide ? relation.toDataset : relation.fromDataset;
    if (withinIds !== undefined && !withinIds.has(otherId)) {
      continue;
    }
    ends.push({ how: howOf(relation, fromThisSide), otherId, relationId: relation.id });
  }
  return ends;
}

/** "Related to FY23 IG Project Corridors via UEI". */
export function relationPhrase(end: RelationEnd, titleOf: (id: string) => string): string {
  const how = end.how === "" ? "" : ` ${end.how}`;
  return `Related to ${titleOf(end.otherId)}${how}`;
}
