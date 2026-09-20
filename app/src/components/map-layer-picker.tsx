import type { FunctionReturnType } from "convex/server";
import { FolderOpen, Layers, MapPin, Plus, Search } from "lucide-react";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import type { LayerTargetType, MembershipRow } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

type CollectionDoc = FunctionReturnType<typeof api.collections.list>[number];
type GroupDoc = FunctionReturnType<typeof api.groups.list>[number];
type DatasetSummary = FunctionReturnType<typeof api.schemas.listSummaries>[number];

export type LayerTarget = { targetId: string; targetType: LayerTargetType };

type LayerCandidate = {
  target: LayerTarget;
  icon: typeof Layers;
  name: string;
  detail: string;
};

function buildCandidates(
  collections: CollectionDoc[],
  groups: GroupDoc[],
  datasets: DatasetSummary[],
  memberships: MembershipRow[],
  addedTargets: Set<string>,
): LayerCandidate[] {
  const groupIdsByCollection = new globalThis.Map<string, string[]>();
  for (const group of groups) {
    if (group.collectionId === undefined) {
      continue;
    }
    const existing = groupIdsByCollection.get(group.collectionId);
    if (existing !== undefined) {
      existing.push(group._id);
    } else {
      groupIdsByCollection.set(group.collectionId, [group._id]);
    }
  }

  return [
    ...collections.map((collection): LayerCandidate => {
      // The count matches what adding the collection as a layer would draw:
      // datasets joined directly plus every dataset of a group living in the
      // collection (a group joins as a single unit and brings its members).
      const memberGroupIds = new Set(groupIdsByCollection.get(collection._id) ?? []),
        contentIds = new Set([
          ...memberships
            .filter((membership) => membership.collectionId === collection._id)
            .map((membership) => membership.schemaId),
          ...datasets
            .filter(
              (dataset) => dataset.groupId !== undefined && memberGroupIds.has(dataset.groupId),
            )
            .map((dataset) => dataset._id),
        ]),
        count = contentIds.size;
      return {
        target: { targetId: collection._id, targetType: "collection" },
        icon: Layers,
        name: collection.name,
        detail: `${count} ${count === 1 ? "dataset" : "datasets"}`,
      };
    }),
    ...groups.map((group): LayerCandidate => {
      const count = datasets.filter((dataset) => dataset.groupId === group._id).length;
      return {
        target: { targetId: group._id, targetType: "group" },
        icon: FolderOpen,
        name: group.name,
        detail:
          group.collectionId === undefined
            ? `${count} ${count === 1 ? "dataset" : "datasets"} · standalone`
            : `${count} ${count === 1 ? "dataset" : "datasets"}`,
      };
    }),
    // Only geospatial datasets render on a map — the picker offers just those.
    ...datasets
      .filter((dataset) => dataset.kind === "geospatial")
      .map((dataset): LayerCandidate => ({
        target: { targetId: dataset._id, targetType: "dataset" },
        icon: MapPin,
        name: dataset.title,
        detail: dataset.geometryType ?? "Geospatial",
      })),
  ].filter(
    (candidate) => !addedTargets.has(`${candidate.target.targetType}:${candidate.target.targetId}`),
  );
}

const SECTION_ORDER: Array<{ targetType: LayerTargetType; label: string }> = [
  { targetType: "collection", label: "Collections" },
  { targetType: "group", label: "Groups" },
  { targetType: "dataset", label: "Datasets" },
];

/**
 * Side panel for adding a layer to a map: every collection, group, and
 * geospatial dataset that isn't already a layer, searchable, grouped by kind.
 */
export function MapLayerPickerSheet({
  addedTargets,
  collections,
  groups,
  datasets,
  memberships,
  open,
  onOpenChange,
  onPick,
}: {
  addedTargets: Set<string>;
  collections: CollectionDoc[];
  groups: GroupDoc[];
  datasets: DatasetSummary[];
  memberships: MembershipRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (target: LayerTarget) => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    normalizedSearch = search.trim().toLowerCase(),
    candidates = buildCandidates(collections, groups, datasets, memberships, addedTargets),
    visible = normalizedSearch
      ? candidates.filter((candidate) => candidate.name.toLowerCase().includes(normalizedSearch))
      : candidates,
    hasCandidates = candidates.length > 0;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add layer</SheetTitle>
          <SheetDescription>
            Add a collection, group, or dataset to this map. Layers draw in list order.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              placeholder="Search collections, groups, datasets…"
              className="pl-7"
            />
          </div>

          {!hasCandidates || visible.length === 0 ? (
            <Empty className="min-h-32 border">
              <EmptyTitle>{hasCandidates ? "No matches" : "Nothing to add"}</EmptyTitle>
              <EmptyDescription>
                {hasCandidates
                  ? "No collections, groups, or datasets match your search."
                  : "Every collection, group, and geospatial dataset is already a layer of this map."}
              </EmptyDescription>
            </Empty>
          ) : (
            SECTION_ORDER.map(({ targetType, label }) => {
              const sectionRows = visible.filter(
                (candidate) => candidate.target.targetType === targetType,
              );
              if (sectionRows.length === 0) {
                return null;
              }
              return (
                <section key={targetType} className="flex flex-col gap-1" aria-label={label}>
                  <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
                  <ul className="flex flex-col gap-1">
                    {sectionRows.map((candidate) => {
                      const key = `${candidate.target.targetType}:${candidate.target.targetId}`,
                        Icon = candidate.icon;
                      return (
                        <li
                          key={key}
                          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{candidate.name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {candidate.detail}
                              </p>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingKey !== undefined}
                            onClick={() => {
                              setPendingKey(key);
                              void onPick(candidate.target).finally(() => {
                                setPendingKey(undefined);
                              });
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {pendingKey === key ? "Adding…" : "Add"}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
