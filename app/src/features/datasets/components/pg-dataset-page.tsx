import type { Geometry } from "@caden/json-cms/react";
import { getReferenceFields } from "@caden/json-cms/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@caden/ui/components/alert-dialog";
import { Badge } from "@caden/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@caden/ui/components/breadcrumb";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@caden/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@caden/ui/components/tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SortingState, Updater } from "@tanstack/react-table";
import {
  ChevronDown,
  Code2,
  Ellipsis,
  FilePlus,
  Globe,
  Lock,
  LockOpen,
  PencilOff,
  Plus,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { useSession } from "@/integrations/supabase/provider";
import type { DatasetEntryRow } from "@/lib/dataset-rows";
import { resolveGeometryRows } from "@/lib/dataset-rows-pg";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import type { DatasetRow } from "@/lib/store/datasets";
import * as entriesStore from "@/lib/store/entries";
import type { EntryRow } from "@/lib/store/entries";
import * as geometriesStore from "@/lib/store/geometries";

import { isLockedForViewer, LOCKED_DATASET_HINT } from "../lib/edit-policy";
import type { JsonSchemaNode } from "../lib/json-schema";
import { declaredPropertyTypes, isSchemaNode } from "../lib/json-schema";
import {
  pgTableStateFromParams,
  resolveUpdater,
  useSearchEntriesPages,
  type PgColumnFilter,
  type PgTableParams,
} from "../lib/pg-entries-table";
import { useSplitReferenceLabels } from "../lib/pg-reference-labels";
import { EntriesTable } from "./entries-table";
import { EntryFormPanel } from "./entry-form-panel";
import { SchemaVisualizer } from "./schema-visualizer";

/**
 * The dataset detail page's Postgres edition (design §14: surfaces split on
 * where the dataset was created — uuid ids were minted by the new backend).
 *
 * Stage-1 surface: header (title/description, lock + visibility controls),
 * the Data tab over `search_entries` (server-side sort/filter/search in the
 * URL, keyset pages), Structure (client-side schema rendering), and the
 * create/edit/delete row flows. The Convex-only tabs (Transform, Analyze,
 * History) and the map/tile path belong to stages 2/4/5/7 and are absent
 * here rather than broken.
 */

/** The route search the PG page reads (structural; the route owns the zod schema — the view union mirrors it exactly so the merge-form navigation typechecks). */
export interface PgDatasetPageSearch {
  entryId?: string;
  filters?: string;
  panel?: "create" | "edit";
  q?: string;
  sort?: string;
  view?: "analyze" | "entries" | "history" | "overview" | "structure" | "transform";
}

/**
 * The dataset page's table rows — the store's `EntryRow` adapted to the
 * shared table's row type (the Convex seam row: `_id`/`_creationTime`/
 * `schemaId`), so one table component serves both backends. `createdAt` is
 * the ISO timestamp the Convex rows' `_creationTime` millisecond field
 * corresponds to.
 */
function tableRowOf(row: EntryRow): DatasetEntryRow {
  return {
    _creationTime: Date.parse(row.createdAt),
    _id: row.id,
    data: row.data,
    // The shared table's row type carries data-core's geometry types — the
    // app never writes a GeometryCollection (data-core excludes it), so one
    // that somehow landed via SQL renders as "No geometry" rather than
    // widening the row type.
    geometryType:
      row.geometryType === null || row.geometryType === "GeometryCollection"
        ? undefined
        : row.geometryType,
    schemaId: row.datasetId,
  };
}

/** The same card a null read gets — the RLS denial fallback too (an invisible dataset reads as missing). */
function PgDatasetNotFoundCard() {
  return (
    <Card className="text-center py-12">
      <CardContent className="pt-6">
        <CardTitle className="mb-2">Dataset Not Found</CardTitle>
        <CardDescription className="mb-4">
          The dataset you're looking for doesn't exist or has been deleted.
        </CardDescription>
        <Link className="text-primary hover:underline" to="/datasets">
          Back to Datasets
        </Link>
      </CardContent>
    </Card>
  );
}

/** The stored JSON Schema as the node the visualizer needs, or `{}` when a malformed payload somehow landed (schemas are validated at create time). */
function schemaNodeOf(dataset: DatasetRow): JsonSchemaNode {
  return isSchemaNode(dataset.jsonSchema) ? dataset.jsonSchema : {};
}

/** The stored JSON Schema as the object the RJSF form needs (validated at create/update; RJSF re-validates at render), or `{}` on a malformed payload. */
function schemaObjectOf(dataset: DatasetRow): object {
  const schema: unknown = dataset.jsonSchema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return {};
  }
  return schema;
}

/** The entry an `edit` panel search targets, or `undefined` for a `create` panel. */
function resolveEntryForPanel(
  rows: DatasetEntryRow[],
  search: PgDatasetPageSearch,
): DatasetEntryRow | undefined {
  if (search.panel !== "edit" || search.entryId === undefined) {
    return undefined;
  }
  return rows.find((row) => row._id === search.entryId);
}

/** The edit panel's prefill geometry, resolved through the seam from the entry's geometry row (inline jsonb synchronously; a storage-backed payload stays unresolved rather than fetched into the textarea — same posture as the Convex page). */
function usePanelGeometry(entryId: string | undefined): Geometry | undefined {
  const geometryQuery = useQuery({
      ...geometriesStore.getByEntryQueryOptions({ entryId: entryId ?? "" }),
      enabled: entryId !== undefined,
    }),
    row = geometryQuery.data,
    resolvedQuery = useQuery({
      enabled:
        entryId !== undefined && row !== undefined && row !== null && row.sourcePath === null,
      queryFn: async () =>
        await resolveGeometryRows(row === undefined || row === null ? [] : [row]),
      queryKey: ["pg:geometry-resolve", "panel", entryId],
    });
  if (entryId === undefined || row === undefined || row === null) {
    return undefined;
  }
  if (resolvedQuery.data === undefined) {
    return undefined;
  }
  return resolvedQuery.data.get(entryId);
}

/** Hosts the create/edit side panel for a Postgres dataset (panel state rides the URL, as on the Convex page). */
function PgEntryPanelHost({
  schemaId,
  dataset,
  rows,
  search,
  onPatchSearch,
}: {
  schemaId: string;
  dataset: DatasetRow;
  rows: DatasetEntryRow[];
  search: PgDatasetPageSearch;
  onPatchSearch: (patch: Partial<PgDatasetPageSearch>) => void;
}) {
  const loadedEntry = resolveEntryForPanel(rows, search),
    // Deep links (`?panel=edit&entryId=…`) can target a row the table hasn't
    // streamed yet — the store's point read resolves those. `null` means the
    // entry is gone and the panel stays closed, as on the Convex page.
    fetchedQuery = useQuery({
      ...entriesStore.getQueryOptions({ entryId: search.entryId ?? "" }),
      enabled: loadedEntry === undefined && search.panel === "edit" && search.entryId !== undefined,
    }),
    fetchedRow = fetchedQuery.data,
    fetchedEntry =
      fetchedRow === undefined || fetchedRow === null ? undefined : tableRowOf(fetchedRow),
    entry = loadedEntry ?? fetchedEntry,
    isOpen = search.panel === "create" || entry !== undefined,
    initialGeometry = usePanelGeometry(entry === undefined ? undefined : entry._id);

  return (
    <EntryFormPanel
      backend="pg"
      entry={entry === undefined ? undefined : { data: entry.data, id: entry._id }}
      initialGeometry={initialGeometry}
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onPatchSearch({ entryId: undefined, panel: undefined });
        }
      }}
      schema={{
        description: dataset.description,
        geometryType: dataset.geometryType,
        kind: dataset.isGeospatial ? "geospatial" : "standard",
        schema: schemaObjectOf(dataset),
      }}
      schemaId={schemaId}
    />
  );
}

function PostgresDatasetBody({
  schemaId,
  search,
  onPatchSearch,
}: {
  schemaId: string;
  search: PgDatasetPageSearch;
  onPatchSearch: (patch: Partial<PgDatasetPageSearch>) => void;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    datasetQuery = useQuery(datasetsStore.getQueryOptions({ datasetId: schemaId })),
    dataset = datasetQuery.data,
    view = search.view === "structure" ? "structure" : "entries",
    tableState = pgTableStateFromParams(search),
    // The declared property types: the server-mode filter menus read them for
    // their variant + served-operator restriction, and the RPC args coerce
    // filter values to the column's type (eq is jsonb containment — the text
    // "5" never matches a numeric cell).
    columnTypes = declaredPropertyTypes(
      dataset === undefined || dataset === null ? {} : dataset.jsonSchema,
    ),
    pages = useSearchEntriesPages(schemaId, tableState, columnTypes),
    rows: DatasetEntryRow[] = pages.rows.map(tableRowOf),
    referenceFields =
      dataset === undefined || dataset === null ? [] : getReferenceFields(dataset.jsonSchema),
    labelsByField = useSplitReferenceLabels(referenceFields, rows),
    [deleteTarget, setDeleteTarget] = useState<DatasetEntryRow | undefined>(undefined),
    [jsonDefinitionOpen, setJsonDefinitionOpen] = useState(false);

  if (datasetQuery.isPending) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (dataset === null || dataset === undefined) {
    return <PgDatasetNotFoundCard />;
  }

  const me = session === null ? undefined : { authId: session.user.id },
    isCreator = me !== undefined && me.authId === dataset.createdBy,
    lockedForViewer = isLockedForViewer(dataset, me),
    displayCount = dataset.entryCount,
    isEmpty = displayCount === 0 && pages.isComplete,
    // Table-state patches ride the route's merge-form navigation — only the
    // changed keys are passed, and an explicit `undefined` deletes the param.
    patchTableState = (patch: Partial<PgTableParams>) => {
      onPatchSearch(patch);
    },
    handleSearchChange = (value: string) => {
      patchTableState(value === "" ? { q: undefined } : { q: value });
    },
    handleSortingChange = (updater: Updater<SortingState>) => {
      const next = resolveUpdater(updater, tableState.sorting);
      patchTableState(next.length === 0 ? { sort: undefined } : { sort: JSON.stringify(next) });
    },
    handleFiltersChange = (filters: PgColumnFilter[] | null) => {
      patchTableState(
        filters === null || filters.length === 0
          ? { filters: undefined }
          : { filters: JSON.stringify(filters) },
      );
    },
    flipVisibility = async () => {
      const next = dataset.publishedVisibility === "author" ? "everyone" : "author";
      try {
        await datasetsStore.setVisibility({ datasetId: schemaId, visibility: next });
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        toast.success(
          next === "author"
            ? "Only you can see this dataset now."
            : "This dataset is visible to everyone signed in.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't update who can see this dataset."));
      }
    },
    flipEditPolicy = async () => {
      const next = dataset.editPolicy === "locked" ? ("open" as const) : ("locked" as const);
      try {
        await datasetsStore.setEditPolicy({ datasetId: schemaId, editPolicy: next });
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        toast.success(
          next === "locked"
            ? "Dataset locked — only you can edit it now."
            : "Dataset unlocked — every signed-in collaborator can edit it again.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't update who can edit this dataset."));
      }
    },
    deleteEntry = async (target: DatasetEntryRow) => {
      try {
        await entriesStore.remove({ entryId: target._id });
        void queryClient.invalidateQueries({ queryKey: ["pg:entries"] });
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        toast.success("Entry deleted.");
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't delete the entry."));
      } finally {
        setDeleteTarget(undefined);
      }
    },
    openEditPanel = (entry: DatasetEntryRow) => {
      if (lockedForViewer) {
        toast.info(LOCKED_DATASET_HINT);
        return;
      }
      onPatchSearch({ entryId: entry._id, panel: "edit" });
    };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
      <div className="flex justify-between items-start mb-8">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/datasets" />}>Datasets</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{dataset.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-primary">{dataset.title}</h1>
            {dataset.editPolicy === "locked" && (
              <Badge
                variant="secondary"
                title={
                  isCreator
                    ? "You locked this dataset — only you can edit it."
                    : LOCKED_DATASET_HINT
                }
              >
                <PencilOff className="h-3.5 w-3.5" />
                Locked
              </Badge>
            )}
          </div>
          <p className="text-lg text-muted-foreground mt-2">{dataset.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={lockedForViewer}
            onClick={() => {
              onPatchSearch({ panel: "create" });
            }}
            title={lockedForViewer ? LOCKED_DATASET_HINT : undefined}
          >
            <Plus className="h-4 w-4 mr-2" />
            Create Entry
          </Button>
          {isCreator && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label="More actions" />}
              >
                <Ellipsis className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    void flipVisibility();
                  }}
                  title={
                    dataset.publishedVisibility === "author"
                      ? "Currently only you can see this dataset — click to share it with everyone signed in."
                      : "Currently every signed-in user can see this dataset — click to restrict it to you."
                  }
                >
                  {dataset.publishedVisibility === "author" ? (
                    <Globe className="h-4 w-4 mr-2" />
                  ) : (
                    <Lock className="h-4 w-4 mr-2" />
                  )}
                  {dataset.publishedVisibility === "author" ? "Visible to everyone" : "Only me"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void flipEditPolicy();
                  }}
                  title={
                    dataset.editPolicy === "locked"
                      ? "Currently only you can edit this dataset — click to let every signed-in collaborator edit."
                      : "Currently every signed-in collaborator can edit this dataset — click to restrict editing to you."
                  }
                >
                  {dataset.editPolicy === "locked" ? (
                    <LockOpen className="h-4 w-4 mr-2" />
                  ) : (
                    <Lock className="h-4 w-4 mr-2" />
                  )}
                  {dataset.editPolicy === "locked" ? "Unlock editing" : "Lock editing"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <Tabs
        value={view}
        onValueChange={(value) => {
          onPatchSearch({ view: value === "entries" ? undefined : value });
        }}
      >
        <TabsList>
          <TabsTrigger value="entries">Data ({displayCount})</TabsTrigger>
          <TabsTrigger value="structure">Structure</TabsTrigger>
        </TabsList>

        <TabsContent value="entries">
          <Card>
            <CardHeader>
              <CardTitle>Data ({displayCount})</CardTitle>
              <CardDescription>
                Data entries created from this schema. Search, sorting, and filters run on the
                database, so the filter menu offers the operators it serves — "contains", "is", and
                "is not" on text, typed comparisons on number and boolean columns.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isEmpty ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FilePlus />
                    </EmptyMedia>
                    <EmptyTitle>No data yet</EmptyTitle>
                    <EmptyDescription>Add your first entry to this schema.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      onClick={() => {
                        onPatchSearch({ panel: "create" });
                      }}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Create First Entry
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : rows.length === 0 && !pages.isComplete ? (
                // First page still in flight — the spinner holds until the
                // page resolves; the empty state gates on COMPLETENESS (the
                // null cursor), never on `isLoading` (ui-polish rule).
                <div className="flex justify-center items-center min-h-40">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                </div>
              ) : (
                <EntriesTable
                  columnTypes={columnTypes}
                  entryCount={displayCount}
                  entries={rows}
                  hasMore={pages.canLoadMore}
                  isLoadingMore={pages.isLoadingMore}
                  isGeospatial={dataset.isGeospatial}
                  labelsByField={labelsByField}
                  onLoadMore={pages.loadMore}
                  onEdit={openEditPanel}
                  onDelete={(entry) => {
                    setDeleteTarget(entry);
                  }}
                  properties={Object.keys(schemaPropertiesOf(dataset))}
                  schema={schemaObjectOf(dataset)}
                  schemaId={schemaId}
                  server={{
                    filters: tableState.filters,
                    onFiltersChange: handleFiltersChange,
                    onSearchChange: handleSearchChange,
                    onSortingChange: handleSortingChange,
                    search: tableState.query,
                    sorting: tableState.sorting,
                  }}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="structure" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Workflow className="h-5 w-5" />
                Schema Structure
              </CardTitle>
              <CardDescription>A visual breakdown of this dataset's fields</CardDescription>
            </CardHeader>
            <CardContent>
              <SchemaVisualizer schema={schemaNodeOf(dataset)} />
            </CardContent>
          </Card>

          <Collapsible
            open={jsonDefinitionOpen}
            onOpenChange={(next) => {
              setJsonDefinitionOpen(next);
            }}
          >
            <Card>
              <CardHeader>
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between text-left">
                  <CardTitle className="flex items-center gap-2">
                    <Code2 className="h-5 w-5" />
                    JSON Definition
                  </CardTitle>
                  <ChevronDown
                    className="size-4 text-muted-foreground transition-transform"
                    style={{ rotate: jsonDefinitionOpen ? "180deg" : undefined }}
                  />
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent>
                  <div className="bg-muted rounded-lg p-4 overflow-x-auto">
                    <pre className="text-sm">{JSON.stringify(dataset.jsonSchema, null, 2)}</pre>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>
      </Tabs>

      <PgEntryPanelHost
        dataset={dataset}
        onPatchSearch={onPatchSearch}
        rows={rows}
        schemaId={schemaId}
        search={search}
      />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(undefined);
          }
        }}
        open={deleteTarget !== undefined}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              The entry's row data, geometry, and any links other entries hold to it are removed.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget !== undefined) {
                  void deleteEntry(deleteTarget);
                }
              }}
            >
              Delete Entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The stored JSON Schema's declared property keys (the table's columns). */
function schemaPropertiesOf(dataset: DatasetRow): Record<string, unknown> {
  const properties = schemaNodeOf(dataset).properties;
  return properties === undefined ? {} : properties;
}

/** The Postgres edition of `/datasets/$schemaId` — mounted by the route when the id was minted by the PG backend. */
export function PostgresDatasetPage({
  schemaId,
  search,
  onPatchSearch,
}: {
  schemaId: string;
  search: PgDatasetPageSearch;
  onPatchSearch: (patch: Partial<PgDatasetPageSearch>) => void;
}) {
  return (
    <QueryErrorBoundary fallback={<PgDatasetNotFoundCard />} resetKey={schemaId}>
      <PostgresDatasetBody onPatchSearch={onPatchSearch} schemaId={schemaId} search={search} />
    </QueryErrorBoundary>
  );
}
