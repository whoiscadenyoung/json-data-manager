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
  FolderKanban,
  Globe,
  Lock,
  LockOpen,
  PencilOff,
  Plus,
  RefreshCw,
  Rocket,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PgAnalysisPanel } from "#/features/analysis";
import { PgAddToProjectSheet, PgPublishDialog, mintPublishKey } from "#/features/publishing";
import { QueryErrorBoundary } from "@/components/query-error-boundary";
import { RouterButton } from "@/components/router-button";
import { useSession } from "@/integrations/supabase/provider";
import type { DatasetEntryRow } from "@/lib/dataset-rows";
import { resolveGeometryRows } from "@/lib/dataset-rows-pg";
import { errorMessage } from "@/lib/errors";
import * as bindingsStore from "@/lib/store/bindings";
import * as datasetsStore from "@/lib/store/datasets";
import type { DatasetRow } from "@/lib/store/datasets";
import * as entriesStore from "@/lib/store/entries";
import type { EntryRow } from "@/lib/store/entries";
import * as geometriesStore from "@/lib/store/geometries";
import * as groupsStore from "@/lib/store/groups";

import { useDatasetLinks } from "../lib/dataset-project-context";
import { isLockedForViewer, LOCKED_DATASET_HINT } from "../lib/edit-policy";
import type { JsonSchemaNode } from "../lib/json-schema";
import { declaredPropertyTypes, isSchemaNode } from "../lib/json-schema";
import {
  pgTableStateFromParams,
  resolveUpdater,
  sanitizePgTableState,
  useSearchEntriesPages,
  type PgColumnFilter,
  type PgTableParams,
} from "../lib/pg-entries-table";
import { useSplitReferenceLabels } from "../lib/pg-reference-labels";
import { viewRowsReadOnlyReason } from "../lib/view-rows";
import { EntriesTable } from "./entries-table";
import { EntryFormPanel } from "./entry-form-panel";
import { PgBindingCard } from "./pg-binding-card";
import { PgBindingHistory } from "./pg-binding-history";
import { PgDatasetExport } from "./pg-dataset-export";
import { PgDatasetMap } from "./pg-dataset-map";
import { PgDatasetOverview } from "./pg-dataset-overview";
import { PgDatasetVisibilityDialog } from "./pg-dataset-visibility-dialog";
import { SchemaVisualizer } from "./schema-visualizer";

/**
 * The dataset detail page's Postgres edition (design §14: surfaces split on
 * where the dataset was created — uuid ids were minted by the new backend).
 *
 * Surface set: header (title/description, lock + visibility, export, the
 * group breadcrumb), the Overview tab (details + collection/group management
 * — stage 3), the Data tab over `search_entries` (server-side
 * sort/filter/search in the URL, keyset pages), Structure (client-side
 * schema rendering), the create/edit/delete row flows, the publish-version
 * dialog (stage 4), and — stage 5 — the Analyze tab (SQL over the PG
 * row-resolution seam). Stage 7 (#206) adds the bound-dataset surfaces for
 * datasets carrying the `source` marker: the sync card (Overview) and the
 * History tab (commit rail + per-sync feed over the store's bindings
 * reads); ordinary datasets keep the tabs below. The map/tile path landed
 * with stage 2 and mounts from the maps feature.
 */

/** The route search the PG page reads (structural; the route owns the zod schema — the view union mirrors it exactly so the merge-form navigation typechecks). */
export interface PgDatasetPageSearch {
  entryId?: string;
  filters?: string;
  panel?: "create" | "edit";
  q?: string;
  sort?: string;
  view?: "analyze" | "entries" | "history" | "overview" | "structure";
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
  const links = useDatasetLinks();
  return (
    <Card className="text-center py-12">
      <CardContent className="pt-6">
        <CardTitle className="mb-2">Dataset Not Found</CardTitle>
        <CardDescription className="mb-4">
          The dataset you're looking for doesn't exist or has been deleted.
        </CardDescription>
        <Link className="text-primary hover:underline" {...links.home}>
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

/** Shared "no declared keys yet" set — the pre-load tick's sanitize target (a stable reference, so the compiler never re-derives it). */
const NO_DECLARED_KEYS: ReadonlySet<string> = new Set<string>();

// oxlint-disable-next-line eslint/complexity -- the page reads both stores' catalog rows and composes the store seams; ad hoc splitting risks these render paths (the same #82 phase-2 note the sibling Convex pages carry).
function PostgresDatasetBody({
  schemaId,
  search,
  onPatchSearch,
}: {
  schemaId: string;
  search: PgDatasetPageSearch;
  onPatchSearch: (patch: Partial<PgDatasetPageSearch>) => void;
}) {
  const links = useDatasetLinks();
  const queryClient = useQueryClient(),
    { session } = useSession(),
    datasetQuery = useQuery(datasetsStore.getQueryOptions({ datasetId: schemaId })),
    dataset = datasetQuery.data,
    bindingQuery = useQuery({
      ...bindingsStore.bindingForDatasetQueryOptions({ datasetId: schemaId }),
      // Only a dataset carrying the `source` marker can have a binding (the
      // marker is stamped by the definer bind RPC alongside the row).
      enabled: dataset !== undefined && dataset !== null && dataset.source !== null,
    }),
    binding = bindingQuery.data,
    isBound = dataset !== null && dataset !== undefined && dataset.source !== null,
    // The active tab rides ?view= (merge-form navigations only); "overview"
    // is the default and deliberately ABSENT from the URL (the ui-polish
    // rule). Stage 5 mounts transform/analyze; stage 7 mounts "history" for
    // BOUND datasets only (an ordinary dataset's ?view=history degrades to
    // overview — the tab doesn't exist for it).
    view =
      search.view === "entries" ||
      search.view === "structure" ||
      search.view === "analyze" ||
      (search.view === "history" && isBound)
        ? search.view
        : "overview",
    // The RPC validates sort/filter keys against the dataset's declared
    // `properties` column — the SAME set here (the row's column, not a
    // schema re-derivation). Until the row lands the set is empty: one
    // default-state tick, then the sanitized state restarts the page chain.
    declaredKeys =
      dataset === undefined || dataset === null
        ? NO_DECLARED_KEYS
        : new Set<string>(dataset.properties),
    tableState = sanitizePgTableState(pgTableStateFromParams(search), declaredKeys),
    // The declared property types: the server-mode filter menus read them for
    // their variant + served-operator restriction, and the RPC args coerce
    // filter values to the column's type (eq is jsonb containment — the text
    // "5" never matches a numeric cell).
    columnTypes = declaredPropertyTypes(
      dataset === undefined || dataset === null ? {} : dataset.jsonSchema,
    ),
    isLive = dataset !== undefined && dataset !== null && dataset.refreshMode === "live",
    pages = useSearchEntriesPages(schemaId, tableState, columnTypes, isLive),
    rows: DatasetEntryRow[] = pages.rows.map(tableRowOf),
    referenceFields =
      dataset === undefined || dataset === null ? [] : getReferenceFields(dataset.jsonSchema),
    labelsByField = useSplitReferenceLabels(referenceFields, rows),
    // The dataset's group, for the breadcrumb — skipped unless the dataset
    // is grouped; `null` (a dangling groupId whose group was deleted) drops
    // the crumb, exactly the Convex page's rule.
    groupQuery = useQuery({
      ...groupsStore.getQueryOptions({
        groupId: dataset === undefined || dataset === null ? "" : (dataset.groupId ?? ""),
      }),
      enabled: dataset !== undefined && dataset !== null && dataset.groupId !== null,
    }),
    [deleteTarget, setDeleteTarget] = useState<DatasetEntryRow | undefined>(undefined),
    [jsonDefinitionOpen, setJsonDefinitionOpen] = useState(false),
    // Stage 4 (#203): the publish-version dialog. The idempotency key mints
    // at OPEN time (not submit), so every submit inside one dialog session
    // re-selects the same frozen version instead of forking a second one.
    [publishOpen, setPublishOpen] = useState(false),
    [visibilityOpen, setVisibilityOpen] = useState(false),
    [publishKey, setPublishKey] = useState(""),
    // #256: the add-to-project sheet — the dataset referenced (linked, a pin
    // at head) from a project the viewer can edit.
    [addToProjectOpen, setAddToProjectOpen] = useState(false);

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
    viewReason = viewRowsReadOnlyReason(dataset),
    isView = viewReason !== undefined,
    groupForBreadcrumb = groupQuery.data,
    displayCount = isLive ? pages.rows.length : dataset.entryCount,
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
    // The share dialog owns every rung change now (#260, ADR 0022) — the
    // old author/everyone flip retired with `published_visibility`.
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
      if (isView) {
        toast.info(viewReason);
        return;
      }
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
          {links.projectId === null && (
            <Breadcrumb className="mb-2">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link to="/datasets" />}>Datasets</BreadcrumbLink>
                </BreadcrumbItem>
                {/* The group crumb mirrors the Convex page's trail (Datasets /
                  {group} / {dataset}); a dangling groupId renders no crumb
                  rather than a dead link. `null` = skipped. */}
                {groupForBreadcrumb !== null && groupForBreadcrumb !== undefined && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbLink
                        render={
                          <Link to="/groups/$groupId" params={{ groupId: groupForBreadcrumb.id }} />
                        }
                      >
                        {groupForBreadcrumb.name}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                  </>
                )}
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{dataset.title}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          )}
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
            {/* Stage 7 (#206): the bound-dataset marker — read-only here; the
                sync card (Overview) carries the live staleness state. */}
            {dataset.source !== null && (
              <Badge
                variant="outline"
                title="Bound to a source — this dataset is a read-only projection; sync applies the source's commits."
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Synced
              </Badge>
            )}
          </div>
          <p className="text-lg text-muted-foreground mt-2">{dataset.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isView && links.projectId !== null && (
            <RouterButton
              params={{ projectId: links.projectId, viewId: schemaId }}
              to="/projects/$projectId/views/$viewId"
              variant="outline"
            >
              <Workflow className="h-4 w-4 mr-2" />
              Open view editor
            </RouterButton>
          )}
          <Button
            disabled={lockedForViewer || isView}
            onClick={() => {
              onPatchSearch({ panel: "create" });
            }}
            title={viewReason ?? (lockedForViewer ? LOCKED_DATASET_HINT : undefined)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Create Entry
          </Button>
          {/* Stage 5 (#204): the export dialog over the PG seam — whole-dataset
              reads through the row-resolution seam, signed URLs for the
              oversized geometry payloads, joined fields from the store's
              registry. */}
          <PgDatasetExport dataset={dataset} />
          {/* #256: reference this dataset from a project — a linked pin at
              head, never a copy (D1/ADR 0018). */}
          <Button
            onClick={() => {
              setAddToProjectOpen(true);
            }}
            title="Add this dataset to one of your projects (a linked reference — nothing is copied)"
            variant="outline"
          >
            <FolderKanban className="h-4 w-4 mr-2" />
            Add to project
          </Button>
          <Button
            disabled={lockedForViewer}
            onClick={() => {
              setPublishKey(mintPublishKey());
              setPublishOpen(true);
            }}
            title={
              lockedForViewer
                ? LOCKED_DATASET_HINT
                : "Freeze the current rows as an immutable version"
            }
            variant="outline"
          >
            <Rocket className="h-4 w-4 mr-2" />
            Publish version
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
                    setVisibilityOpen(true);
                  }}
                  title={`Currently visible at “${dataset.visibility}” — click to change who can see this dataset.`}
                >
                  {dataset.visibility === "members" ? (
                    <Lock className="h-4 w-4 mr-2" />
                  ) : (
                    <Globe className="h-4 w-4 mr-2" />
                  )}
                  Share dataset…
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

      {dataset.isGeospatial && dataset.geometryType !== null && <PgDatasetMap dataset={dataset} />}

      <Tabs
        value={view}
        onValueChange={(value) => {
          // Tab switches write ?view= so the active tab survives reloads and
          // is linkable; "overview" is the default and stays out of the URL
          // (the ui-polish rule). The route's navigate MERGES — never
          // replaces — so ?panel=/?q= ride along.
          onPatchSearch({ view: value === "overview" ? undefined : value });
        }}
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="entries">Data ({displayCount})</TabsTrigger>
          <TabsTrigger value="structure">Structure</TabsTrigger>
          <TabsTrigger value="analyze">Analyze</TabsTrigger>
          {isBound && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {/* Stage 7 (#206): the bound dataset's sync card leads its
              Overview — status, Sync/Reconcile/Resume, retention, unbind. */}
          {isBound && <PgBindingCard datasetId={schemaId} isCreator={isCreator} />}
          <PgDatasetOverview
            dataset={dataset}
            lockedHint={lockedForViewer ? LOCKED_DATASET_HINT : undefined}
          />
        </TabsContent>

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
                    <EmptyDescription>
                      {isView
                        ? "This view has no rows yet. Run it from the view editor to fill it."
                        : "Add your first entry to this schema."}
                    </EmptyDescription>
                  </EmptyHeader>
                  {!isView && (
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
                  )}
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
                  onDelete={
                    isView
                      ? undefined
                      : (entry) => {
                          setDeleteTarget(entry);
                        }
                  }
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

        <TabsContent value="analyze">
          {/* Stage 5 (#204): freeform read-only SQL — the same worker and
              DuckDB-WASM engine as the Convex tab, fed from the PG seam. */}
          <PgAnalysisPanel dataset={dataset} datasetTitle={dataset.title} schemaId={schemaId} />
        </TabsContent>

        {/* Stage 7 (#206): the bound dataset's History tab — the applied
            commit rail (with the diff overlay on selection) plus the
            per-sync feed. BOUND datasets only; ?view=history degrades to
            overview for ordinary ones (the view derivation above). */}
        {isBound && binding !== null && binding !== undefined && (
          <TabsContent value="history" className="space-y-6">
            <PgBindingHistory binding={binding} isGeospatial={dataset.isGeospatial} />
          </TabsContent>
        )}

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

      {/* A view's rows are written only by its run: never open the entry form. */}
      {!isView && (
        <PgEntryPanelHost
          dataset={dataset}
          onPatchSearch={onPatchSearch}
          rows={rows}
          schemaId={schemaId}
          search={search}
        />
      )}

      {/* Stage 4 (#203): the PG publish flow — freeze the current rows as an
          immutable version (drafts flip into the catalog with it). */}
      <PgPublishDialog
        dataset={dataset}
        onOpenChange={setPublishOpen}
        open={publishOpen}
        publishKey={publishKey}
      />
      <PgDatasetVisibilityDialog
        dataset={dataset}
        onOpenChange={setVisibilityOpen}
        open={visibilityOpen}
      />

      {/* #256: the add-to-project sheet over this dataset. */}
      <PgAddToProjectSheet
        artifactId={schemaId}
        onOpenChange={setAddToProjectOpen}
        open={addToProjectOpen}
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
