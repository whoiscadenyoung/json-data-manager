import { useResolvedGeometries } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import { Download, Layers, MapIcon, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "#convex/_generated/api";
import { AddToMapSheet } from "@/components/add-to-map-sheet";
import { DatasetList } from "@/components/dataset-list";
import type { Dataset } from "@/components/dataset-list";
import { DatasetPickerSheet } from "@/components/dataset-picker-sheet";
import { ExportDialog } from "@/components/export-dialog";
import type { ExportFormat, ExportFormatOption } from "@/components/export-dialog";
import { GroupFormPanel } from "@/components/group-form-panel";
import { GroupMap } from "@/components/group-map";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveDatasetGeometryRows } from "@/lib/dataset-rows";
import { useGeometriesBySchemas } from "@/lib/dataset-rows-react";
import {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "@/lib/export";
import type { LayerSourceSplit } from "@/lib/layer-source";
import { splitSchemaIdsByDecision, useTileArchiveSources } from "@/lib/layer-source";

/**
 * The group map's on-demand export materialization: tile-path datasets'
 * geometry rows (never fetched for rendering) merged into the row path's
 * already-resolved map. One pass per tile-path dataset, sequential; each
 * dataset's rows resolve together once its paging ends.
 */
async function mergedResolvedGeometries(
  rowPathResolved: globalThis.Map<string, Geometry>,
  tileSources: Array<{ schemaId: string; url: string }>,
): Promise<globalThis.Map<string, Geometry>> {
  const merged = new globalThis.Map(rowPathResolved);
  for (const source of tileSources) {
    // oxlint-disable-next-line no-await-in-loop -- inherently sequential per dataset (each merge builds on the last); rows within one dataset resolve in parallel.
    for (const [rowId, geometry] of await resolveDatasetGeometryRows(source.schemaId)) {
      merged.set(rowId, geometry);
    }
  }
  return merged;
}

/** The spinner holds until the group's layers can mount: entries in, no source decision still pending, and the row fan-out finished (tile-only groups skip that wait). */
function isGroupWorkspaceLoading(
  entries: unknown,
  split: LayerSourceSplit,
  geometries: unknown,
): boolean {
  return (
    entries === undefined ||
    split.sourcesPending ||
    (geometries === undefined && split.tileSources.length === 0)
  );
}

/** A nullable list as an empty list — the row path serves `undefined` before its first rows land, and the map renders tile sources (or nothing) then. */
function withEmptyRows<T>(rows: T[] | undefined): T[] {
  return rows === undefined ? [] : rows;
}

export const Route = createFileRoute("/groups/$groupId")({
  component: GroupDetailPage,
});

/**
 * A group's own page: every member dataset's geometries rendered together
 * on one map — points and shapes layered directly, one color per dataset —
 * so the group reads as a single layer of data, followed by the member
 * dataset list. The group is managed here too: its name/description can be
 * edited and datasets can be added directly, whether the group is nested in
 * a collection or standalone.
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function GroupDetailPage() {
  const { groupId } = Route.useParams(),
    navigate = useNavigate(),
    convex = useConvex(),
    group = useQuery(api.groups.get, { groupId }),
    parentCollection = useQuery(
      api.collections.get,
      group && group.collectionId !== undefined ? { collectionId: group.collectionId } : "skip",
    ),
    groups = useQuery(api.groups.list, {}),
    allDatasets = useQuery(api.schemas.listSummaries),
    datasets = (allDatasets ?? []).filter((dataset) => dataset.groupId === groupId),
    addCandidates = (allDatasets ?? []).filter((dataset) => dataset.groupId !== groupId),
    memberSchemaIds = datasets.map((dataset) => dataset._id),
    geospatialSchemaIds = datasets
      .filter((dataset) => dataset.kind === "geospatial")
      .map((dataset) => dataset._id),
    // Layer-source decisions (issue #58 part 4): a dataset with a fresh tile
    // archive renders via `pmtiles://` range requests and is excluded from
    // the row fan-out; everything else stays on today's row path.
    sourceBySchema = useTileArchiveSources(
      datasets.filter((dataset) => dataset.kind === "geospatial"),
    ),
    split = splitSchemaIdsByDecision(geospatialSchemaIds, sourceBySchema),
    rowSchemaIds = split.rowSchemaIds,
    tileSources = split.tileSources,
    // Entry data feeds both the map's feature-detail popups and the export
    // dialog (regular datasets export too, so every member is fetched).
    entries = useQuery(
      api.entries.listEntriesForSchemas,
      memberSchemaIds.length > 0 ? { schemaIds: memberSchemaIds } : "skip",
    ),
    { geometries, loaders } = useGeometriesBySchemas(rowSchemaIds),
    resolvedGeometries = useResolvedGeometries(geometries ?? []),
    // Per-dataset row counts for the member list, derived from the entries
    // this page already fetches for the map's popups and the exports — no
    // extra query. Undefined while the entries are still loading, which just
    // hides the regular datasets' "N rows" labels until they're in.
    entryCounts = entries
      ? entries.reduce<Map<string, number>>(
          (counts, entry) => counts.set(entry.schemaId, (counts.get(entry.schemaId) ?? 0) + 1),
          new Map(),
        )
      : undefined,
    setSchemaGroup = useMutation(api.collections.setSchemaGroup),
    deleteGroup = useMutation(api.groups.remove),
    [editingGroup, setEditingGroup] = useState(false),
    [addDatasetOpen, setAddDatasetOpen] = useState(false),
    [addToMapOpen, setAddToMapOpen] = useState(false),
    [pendingDelete, setPendingDelete] = useState(false),
    handleAddDataset = async (dataset: Dataset) => {
      await setSchemaGroup({ groupId, schemaId: dataset._id });
      toast.success(`Added "${dataset.title}" to "${group ? group.name : "group"}".`);
    },
    handleMoveToGroup = async (dataset: Dataset, targetGroupId: string | null) => {
      try {
        await setSchemaGroup({ groupId: targetGroupId, schemaId: dataset._id });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to move dataset.");
      }
    },
    handleRemoveDataset = async (dataset: Dataset) => {
      try {
        await setSchemaGroup({ groupId: null, schemaId: dataset._id });
        toast.success(`Removed "${dataset.title}" from the group.`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to remove dataset.");
      }
    },
    handleDeleteGroup = async () => {
      try {
        await deleteGroup({ groupId });
        toast.success("Group deleted.");
        await navigate({ to: "/datasets" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to delete group.");
      }
    },
    [exportOpen, setExportOpen] = useState(false),
    exportFormats: ExportFormatOption[] =
      geospatialSchemaIds.length > 0
        ? [
            {
              value: "geojson",
              label: "GeoJSON",
              hint: `One .geojson FeatureCollection per geospatial dataset (${geospatialSchemaIds.length} file(s)) — schemas stay separate.`,
            },
            {
              value: "json",
              label: "JSON",
              hint: `One .json file per dataset (${datasets.length} file(s)) — schemas stay separate.`,
            },
            {
              value: "excel",
              label: "Excel (.xlsx)",
              hint: `One workbook with a worksheet per dataset (${datasets.length} sheet(s)).`,
            },
          ]
        : [
            {
              value: "json",
              label: "JSON",
              hint: `One .json file per dataset (${datasets.length} file(s)) — schemas stay separate.`,
            },
            {
              value: "excel",
              label: "Excel (.xlsx)",
              hint: `One workbook with a worksheet per dataset (${datasets.length} sheet(s)).`,
            },
          ],
    handleExportConfirm = async (format: ExportFormat, includeSchema: boolean) => {
      if (!entries) {
        return;
      }
      // Dataset rows are summaries (issue #53) — the JSON-schema payloads only
      // exist on the full docs, so an export that wants them reads each one
      // here, on demand, instead of the page carrying them all the time.
      const schemaDocs = await Promise.all(
          datasets.map(async (dataset) => convex.query(api.schemas.get, { schemaId: dataset._id })),
        ),
        schemasById = new globalThis.Map(
          datasets.flatMap((dataset, index) => {
            const doc = schemaDocs[index];
            return doc !== null && doc !== undefined ? [[dataset._id, doc.schema] as const] : [];
          }),
        ),
        entriesOf = (dataset: Dataset) => entries.filter((entry) => entry.schemaId === dataset._id),
        downloadSchemaFile = (dataset: Dataset) => {
          if (includeSchema) {
            const schema = schemasById.get(dataset._id);
            if (schema !== undefined) {
              downloadText(
                JSON.stringify(schema, null, 2),
                `${slugify(dataset.title)}-schema.json`,
              );
            }
          }
        },
        // Tile-path datasets' geometry rows were never fetched (their maps
        // render from the archive) — materialize each one now, once, and
        // merge with whatever the row path already resolved.
        exportResolvedGeometries = await mergedResolvedGeometries(resolvedGeometries, tileSources);

      if (format === "geojson") {
        // GeoJSON is a geospatial format — regular datasets in the group
        // have no geometry to express and are skipped.
        for (const dataset of datasets.filter((candidate) => candidate.kind === "geospatial")) {
          downloadText(
            JSON.stringify(
              buildGeoJsonCollection(entriesOf(dataset), exportResolvedGeometries, dataset._id),
              null,
              2,
            ),
            `${slugify(dataset.title)}.geojson`,
          );
          downloadSchemaFile(dataset);
        }
        toast.success(`Exported ${geospatialSchemaIds.length} GeoJSON file(s).`);
        return;
      }
      if (format === "json") {
        for (const dataset of datasets) {
          downloadText(
            JSON.stringify(
              buildJsonPayload(schemasById.get(dataset._id), entriesOf(dataset)),
              null,
              2,
            ),
            `${slugify(dataset.title)}.json`,
          );
          downloadSchemaFile(dataset);
        }
        toast.success(`Exported ${datasets.length} JSON file(s).`);
        return;
      }
      await exportExcelWorkbook(
        datasets.map((dataset) => ({ name: dataset.title, rows: entryRows(entriesOf(dataset)) })),
        `${slugify(group ? group.name : "group")}.xlsx`,
      );
      toast.success("Exported workbook.");
    };

  if (group === undefined || groups === undefined || allDatasets === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!group) {
    return (
      <Card className="mx-auto mt-8 max-w-md text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Group Not Found</CardTitle>
          <CardDescription className="mb-4">
            The group you're looking for doesn't exist or has been deleted.
          </CardDescription>
          <Link to="/datasets">
            <Button>Back to Datasets</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const hasGeospatialDatasets = geospatialSchemaIds.length > 0,
    parentCollectionId = group.collectionId,
    isNested = parentCollectionId !== undefined;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
      <div className="flex justify-between items-start mb-8">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                {isNested ? (
                  <BreadcrumbLink render={<Link to="/collections" />}>Collections</BreadcrumbLink>
                ) : (
                  <BreadcrumbLink render={<Link to="/datasets" />}>Datasets</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {parentCollectionId !== undefined && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={
                        <Link
                          to="/collections/$collectionId"
                          params={{ collectionId: parentCollectionId }}
                        />
                      }
                    >
                      {parentCollection ? parentCollection.name : "Collection"}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </>
              )}
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{group.name}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="text-3xl font-bold text-primary flex items-center gap-2">
            <Layers className="h-6 w-6" />
            {group.name}
          </h1>
          {group.description && (
            <p className="text-lg text-muted-foreground mt-2">{group.description}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditingGroup(true);
            }}
          >
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPendingDelete(true);
            }}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setAddDatasetOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add dataset
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setExportOpen(true);
            }}
            disabled={datasets.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Export ({datasets.length})
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setAddToMapOpen(true);
            }}
          >
            <MapIcon className="h-4 w-4 mr-2" />
            Add to map
          </Button>
        </div>
      </div>

      {hasGeospatialDatasets && (
        <section className="mb-8" aria-label="Combined map of the datasets in this group">
          {loaders}
          {/* The spinner holds until every row-path member's full pagination
              pass is done (and while any tile decision is still pending) — a
              group whose datasets all render from tile archives mounts
              immediately. */}
          {isGroupWorkspaceLoading(entries, split, geometries) ? (
            <div className="flex justify-center items-center h-[500px] rounded-lg border border-border">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : (
            <GroupMap
              datasets={datasets}
              geometries={withEmptyRows(geometries)}
              entries={withEmptyRows(entries)}
              tileSources={tileSources}
            />
          )}
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Datasets ({datasets.length})</CardTitle>
          <CardDescription>Datasets in this group</CardDescription>
        </CardHeader>
        <CardContent>
          <DatasetList
            datasets={datasets}
            groups={groups}
            entryCounts={entryCounts}
            emptyLabel="No datasets in this group yet."
            onMoveToGroup={(dataset, targetGroupId) => {
              void handleMoveToGroup(dataset, targetGroupId);
            }}
            onRemoveFromCollection={(dataset) => {
              void handleRemoveDataset(dataset);
            }}
          />
        </CardContent>
      </Card>

      <GroupFormPanel group={group} open={editingGroup} onOpenChange={setEditingGroup} />

      <DatasetPickerSheet
        title="Add dataset to group"
        description="Choose a dataset to add to this group."
        candidates={addCandidates}
        open={addDatasetOpen}
        onOpenChange={setAddDatasetOpen}
        onPick={handleAddDataset}
      />

      <AddToMapSheet
        open={addToMapOpen}
        onOpenChange={setAddToMapOpen}
        target={{ targetId: groupId, targetType: "group", targetName: group.name }}
      />

      <ConfirmDialog
        open={pendingDelete}
        onOpenChange={setPendingDelete}
        title={`Delete "${group.name}"?`}
        description="Its datasets are not deleted — they just become ungrouped."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          void handleDeleteGroup();
        }}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        heading={`Export "${group.name}" (${datasets.length} datasets)`}
        formatOptions={exportFormats}
        defaultFormat={geospatialSchemaIds.length > 0 ? "geojson" : "json"}
        schemaLabel="each dataset"
        onConfirm={handleExportConfirm}
      />
    </div>
  );
}
