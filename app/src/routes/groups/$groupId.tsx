import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { useResolvedGeometries } from "@caden/json-cms/react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Download, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "#convex/_generated/api";
import { DatasetList } from "@/components/dataset-list";
import type { Dataset } from "@/components/dataset-list";
import { DatasetPickerSheet } from "@/components/dataset-picker-sheet";
import { ExportDialog } from "@/components/export-dialog";
import type { ExportFormat, ExportFormatOption } from "@/components/export-dialog";
import { GroupFormPanel } from "@/components/group-form-panel";
import { GroupMap } from "@/components/group-map";
import { useGeometriesBySchemas } from "@/components/schema-geometries-loader";
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
import {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "@/lib/export";

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
function GroupDetailPage() {
  const { groupId } = Route.useParams(),
    navigate = useNavigate(),
    group = useQuery(api.groups.get, { groupId }),
    parentCollection = useQuery(
      api.collections.get,
      group && group.collectionId !== undefined ? { collectionId: group.collectionId } : "skip",
    ),
    groups = useQuery(api.groups.list, {}),
    allDatasets = useQuery(api.schemas.list),
    datasets = (allDatasets ?? []).filter((dataset) => dataset.groupId === groupId),
    addCandidates = (allDatasets ?? []).filter((dataset) => dataset.groupId !== groupId),
    memberSchemaIds = datasets.map((dataset) => dataset._id),
    geospatialSchemaIds = datasets
      .filter((dataset) => dataset.kind === "geospatial")
      .map((dataset) => dataset._id),
    // Entry data feeds both the map's feature-detail popups and the export
    // dialog (regular datasets export too, so every member is fetched).
    entries = useQuery(
      api.entries.listEntriesForSchemas,
      memberSchemaIds.length > 0 ? { schemaIds: memberSchemaIds } : "skip",
    ),
    { geometries, loaders } = useGeometriesBySchemas(geospatialSchemaIds),
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
      const entriesOf = (dataset: Dataset) =>
          entries.filter((entry) => entry.schemaId === dataset._id),
        downloadSchemaFile = (dataset: Dataset) => {
          if (includeSchema) {
            downloadText(
              JSON.stringify(dataset.schema, null, 2),
              `${slugify(dataset.title)}-schema.json`,
            );
          }
        };

      if (format === "geojson") {
        // GeoJSON is a geospatial format — regular datasets in the group
        // have no geometry to express and are skipped.
        for (const dataset of datasets.filter((dataset) => dataset.kind === "geospatial")) {
          downloadText(
            JSON.stringify(
              buildGeoJsonCollection(entriesOf(dataset), resolvedGeometries, dataset._id),
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
            JSON.stringify(buildJsonPayload(dataset.schema, entriesOf(dataset)), null, 2),
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
        </div>
      </div>

      {hasGeospatialDatasets && (
        <section className="mb-8" aria-label="Combined map of the datasets in this group">
          {loaders}
          {geometries === undefined || entries === undefined ? (
            <div className="flex justify-center items-center h-[500px] rounded-lg border border-border">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : (
            <GroupMap datasets={datasets} geometries={geometries} entries={entries} />
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
