import type { FunctionReturnType } from "convex/server";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import {
  FolderOpen,
  Import,
  Layers as LayersIcon,
  Link2,
  MapPin,
  Plus,
  Search,
} from "lucide-react";
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
import type { ProjectLayerRow } from "#/lib/projects/map-layers";
import { api } from "#convex/_generated/api";

type CollectionDoc = FunctionReturnType<typeof api.collections.list>[number];
type GroupDoc = FunctionReturnType<typeof api.groups.list>[number];

/** One addable row of the picker, already resolved to its mutation target. */
type PickerCandidate = {
  key: string;
  section: PickerSection;
  id: string;
  title: string;
  detail: string;
};

type PickerSection = "collections" | "datasets" | "groups" | "import" | "layers";

const SECTION_ORDER: Array<{ label: string; section: PickerSection }> = [
  { label: "Project layers", section: "layers" },
  { label: "Datasets in this project", section: "datasets" },
  { label: "Import from catalog", section: "import" },
  { label: "Collections", section: "collections" },
  { label: "Groups", section: "groups" },
];

/** One geospatial dataset member of the project (membership id + dataset id), pre-resolved by the page. */
export type PickerDatasetMember = { datasetId: string; geometryType?: string; membershipId: string; title: string };

/**
 * The picker's candidates, built in one pass (module-level — the component
 * stays under the complexity budget). Sections:
 *
 * - "Project layers": owned layers not yet placed — the pure restyle/reuse
 *   add (`projectMaps.addLayer`).
 * - "Datasets in this project": geospatial members no project layer styles
 *   yet — one click auto-layers them (`projectMaps.addDatasetToMap` creates
 *   the owned layer + placement; already-styled members are skipped, their
 *   layer is the section-1 candidate).
 * - "Import from catalog": geospatial catalog datasets the project doesn't
 *   hold — the same auto-layer click IMPORTS them (pinned at head) on the
 *   way in.
 * - "Collections"/"Groups": "add all datasets" — each geospatial member
 *   expands to its own layer, no-geometry ones reported in the toast.
 */
/** The "Project layers" section: owned layers not yet placed — the pure restyle/reuse add. */
function layerCandidates(
  projectLayers: ProjectLayerRow[],
  placedMemberIds: ReadonlySet<string>,
): PickerCandidate[] {
  const candidates: PickerCandidate[] = [];
  for (const layer of projectLayers) {
    if (layer.membershipId === undefined || placedMemberIds.has(layer.membershipId)) {
      continue;
    }
    candidates.push({
      detail:
        layer.kind === "group"
          ? "Group layer — places every child with it"
          : layer.lifecycle === "draft"
            ? "Data layer · draft"
            : "Data layer",
      id: layer.membershipId,
      key: `layer:${layer._id}`,
      section: "layers",
      title: layer.name,
    });
  }
  return candidates;
}

/** The "Datasets in this project" section: geospatial members no project layer styles yet (auto-layer is idempotent — already-styled members' layers are the section-1 candidates). */
function datasetCandidates(
  memberDatasets: PickerDatasetMember[],
  styledMemberIds: ReadonlySet<string>,
): PickerCandidate[] {
  const candidates: PickerCandidate[] = [];
  for (const member of memberDatasets) {
    if (styledMemberIds.has(member.membershipId)) {
      continue;
    }
    candidates.push({
      detail: member.geometryType === undefined ? "Geospatial" : member.geometryType,
      id: member.datasetId,
      key: `dataset:${member.datasetId}`,
      section: "datasets",
      title: member.title,
    });
  }
  return candidates;
}

/** The "Import from catalog" section: geospatial catalog datasets the project doesn't hold — the same auto-layer click IMPORTS them (pinned at head) on the way in. */
function importCandidates(
  catalogDatasets: Array<{ _id: string; kind?: string; title: string }>,
  memberDatasetIds: ReadonlySet<string>,
): PickerCandidate[] {
  const candidates: PickerCandidate[] = [];
  for (const dataset of catalogDatasets) {
    if (dataset.kind !== "geospatial" || memberDatasetIds.has(dataset._id)) {
      continue;
    }
    candidates.push({
      detail: "Import — joins the project pinned at its newest version",
      id: dataset._id,
      key: `import:${dataset._id}`,
      section: "import",
      title: dataset.title,
    });
  }
  return candidates;
}

/** The "Collections"/"Groups" sections: "add all datasets" — each geospatial member expands to its own layer, no-geometry ones reported in the toast. */
function expansionCandidates(
  collections: CollectionDoc[],
  groups: GroupDoc[],
): PickerCandidate[] {
  const candidates: PickerCandidate[] = [];
  for (const collection of collections) {
    candidates.push({
      detail: "Adds every geospatial dataset as its own layer",
      id: collection._id,
      key: `collection:${collection._id}`,
      section: "collections",
      title: collection.name,
    });
  }
  for (const group of groups) {
    candidates.push({
      detail: "Adds every geospatial member as its own layer",
      id: group._id,
      key: `group:${group._id}`,
      section: "groups",
      title: group.name,
    });
  }
  return candidates;
}

function buildPickerCandidates(
  projectLayers: ProjectLayerRow[],
  placedMemberIds: ReadonlySet<string>,
  styledMemberIds: ReadonlySet<string>,
  memberDatasets: PickerDatasetMember[],
  catalogDatasets: Array<{ _id: string; kind?: string; title: string }>,
  memberDatasetIds: ReadonlySet<string>,
  collections: CollectionDoc[],
  groups: GroupDoc[],
): PickerCandidate[] {
  return [
    ...layerCandidates(projectLayers, placedMemberIds),
    ...datasetCandidates(memberDatasets, styledMemberIds),
    ...importCandidates(catalogDatasets, memberDatasetIds),
    ...expansionCandidates(collections, groups),
  ];
}

/** One project's published layers, for the link section — `undefined` while the pick's read streams. */
function PublishedLayerList({
  onLinkAndPlace,
  pending,
  projectId,
}: {
  onLinkAndPlace: (sourceLayerId: string) => Promise<void>;
  pending: boolean;
  projectId: string;
}) {
  const layers = useQuery({ ...convexQuery(api.layers.list, { projectId }) }).data,
    published = (layers ?? []).filter((layer) => layer.lifecycle === "published");
  if (layers === undefined) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">Loading this project's layers…</p>
    );
  }
  if (published.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No published layers here yet — publishing a layer freezes a version other projects can
        link.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {published.map((layer) => (
        <li
          key={layer._id}
          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <LayersIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{layer.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {layer.kind === "group" ? "Group layer" : "Data layer"} · published
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              void onLinkAndPlace(layer._id);
            }}
          >
            <Link2 className="h-3.5 w-3.5" />
            {pending ? "Linking…" : "Link & place"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The add-layer sheet (phase 4): the map's own project's layers first, then
 * inline import (a dataset auto-layers itself — membership, owned layer, and
 * placement in one click), "add all datasets" for collections/groups, and a
 * LINK section — a published layer of another of the viewer's projects links
 * in as a pinned read-only member and lands on the map in one action.
 */
export function MapLayerPickerSheet({
  canWrite,
  catalogDatasets,
  collections,
  groups,
  memberDatasetIds,
  memberDatasets,
  open,
  otherProjects,
  placedMemberIds,
  projectLayers,
  styledMemberIds,
  viewerHint,
  onAddAll,
  onAddDataset,
  onAddExistingLayer,
  onLinkAndPlace,
  onOpenChange,
}: {
  canWrite: boolean;
  catalogDatasets: Array<{ _id: string; kind?: string; title: string }>;
  collections: CollectionDoc[];
  groups: GroupDoc[];
  memberDatasetIds: ReadonlySet<string>;
  memberDatasets: PickerDatasetMember[];
  open: boolean;
  /** The viewer's OTHER projects — a linked layer comes from one of them. */
  otherProjects: Array<{ _id: string; title: string }>;
  placedMemberIds: ReadonlySet<string>;
  projectLayers: ProjectLayerRow[];
  styledMemberIds: ReadonlySet<string>;
  viewerHint: string;
  onAddAll: (target: { collectionId?: string; groupId?: string }) => Promise<void>;
  onAddDataset: (datasetId: string) => Promise<void>;
  onAddExistingLayer: (layerMemberId: string) => Promise<void>;
  onLinkAndPlace: (sourceLayerId: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState(""),
    [pendingKey, setPendingKey] = useState<string | undefined>(),
    [linkProjectId, setLinkProjectId] = useState<string | undefined>(),
    normalizedSearch = search.trim().toLowerCase(),
    candidates = buildPickerCandidates(
      projectLayers,
      placedMemberIds,
      styledMemberIds,
      memberDatasets,
      catalogDatasets,
      memberDatasetIds,
      collections,
      groups,
    ),
    visible = normalizedSearch
      ? candidates.filter((candidate) => candidate.title.toLowerCase().includes(normalizedSearch))
      : candidates,
    hasCandidates = candidates.length > 0,
    run = async (key: string, action: () => Promise<void>): Promise<void> => {
      setPendingKey(key);
      try {
        await action();
      } finally {
        setPendingKey(undefined);
      }
    };
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setSearch("");
          setLinkProjectId(undefined);
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Add layer</SheetTitle>
          <SheetDescription>
            Place one of the project's layers, layer a dataset (auto-created), or link a published
            layer from another project. Layers draw in list order.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-6">
          {!canWrite ? (
            <Empty className="min-h-32 border">
              <EmptyTitle>Read-only seat</EmptyTitle>
              <EmptyDescription>{viewerHint}</EmptyDescription>
            </Empty>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                  }}
                  placeholder="Search layers, datasets, collections…"
                  className="pl-7"
                />
              </div>

              {SECTION_ORDER.map(({ label, section }) => {
                const sectionRows = visible.filter(
                  (candidate) => candidate.section === section,
                );
                if (sectionRows.length === 0) {
                  return null;
                }
                return (
                  <section key={section} className="flex flex-col gap-1" aria-label={label}>
                    <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
                    <ul className="flex flex-col gap-1">
                      {sectionRows.map((candidate) => (
                        <li
                          key={candidate.key}
                          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <SectionIcon section={candidate.section} />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{candidate.title}</p>
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
                              if (candidate.section === "layers") {
                                void run(candidate.key, async () => onAddExistingLayer(candidate.id));
                              } else if (candidate.section === "import") {
                                void run(candidate.key, async () => onAddDataset(candidate.id));
                              } else if (candidate.section === "datasets") {
                                void run(candidate.key, async () => onAddDataset(candidate.id));
                              } else if (candidate.section === "collections") {
                                void run(candidate.key, async () =>
                                  onAddAll({ collectionId: candidate.id }),
                                );
                              } else {
                                void run(candidate.key, async () => onAddAll({ groupId: candidate.id }));
                              }
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {pendingKey === candidate.key ? "Adding…" : "Add"}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}

              <section className="flex flex-col gap-1" aria-label="Link a published layer">
                <h3 className="text-xs font-medium text-muted-foreground">
                  Link a published layer
                </h3>
                {otherProjects.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    You don't belong to any other project — a linked layer comes from one of yours.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1">
                      {otherProjects.map((project) => (
                        <Button
                          key={project._id}
                          type="button"
                          size="sm"
                          variant={linkProjectId === project._id ? "secondary" : "ghost"}
                          disabled={pendingKey !== undefined}
                          onClick={() => {
                            setLinkProjectId(project._id);
                          }}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          {project.title}
                        </Button>
                      ))}
                    </div>
                    {linkProjectId !== undefined && (
                      <PublishedLayerList
                        onLinkAndPlace={async (sourceLayerId) =>
                          run(`link:${sourceLayerId}`, async () => onLinkAndPlace(sourceLayerId))
                        }
                        pending={pendingKey !== undefined}
                        projectId={linkProjectId}
                      />
                    )}
                  </>
                )}
              </section>

              {hasCandidates && visible.length === 0 && (
                <Empty className="min-h-24 border">
                  <EmptyTitle>No matches</EmptyTitle>
                  <EmptyDescription>Nothing matches your search.</EmptyDescription>
                </Empty>
              )}
              {!hasCandidates && (
                <Empty className="min-h-32 border">
                  <EmptyTitle>Nothing to add</EmptyTitle>
                  <EmptyDescription>
                    Every project layer is placed and every geospatial dataset already has its
                    layer. Import a dataset or add one to the project first.
                  </EmptyDescription>
                </Empty>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The per-section icon (module-level branch — the row stays simple). */
function SectionIcon({ section }: { section: PickerSection }) {
  if (section === "layers" || section === "collections") {
    return <LayersIcon className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (section === "groups") {
    return <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (section === "import") {
    return <Import className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />;
}
