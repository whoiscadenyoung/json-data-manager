import type { Geometry as GeometryShape } from "@caden/json-cms/react";
import { useAllPaginated, useResolvedGeometries } from "@caden/json-cms/react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery as useConvexQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  CheckCircle,
  ChevronDown,
  Code2,
  Download,
  Ellipsis,
  FileDown,
  FilePlus,
  MapIcon,
  MapPinned,
  Pencil,
  Plus,
  UploadCloud,
  Workflow,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { AddToMapSheet } from "@/components/add-to-map-sheet";
import { DatasetHistoryPanel } from "@/components/dataset-history-panel";
import { DatasetOverview } from "@/components/dataset-overview";
import { EntriesMap } from "@/components/entries-map";
import { EntriesTable } from "@/components/entries-table";
import { EntryFormPanel } from "@/components/entry-form-panel";
import { ExportDialog } from "@/components/export-dialog";
import type { ExportFormat, ExportFormatOption } from "@/components/export-dialog";
import { GeospatialConversionPanel } from "@/components/geospatial-conversion-panel";
import { RouterButton } from "@/components/router-button";
import { SchemaVisualizer } from "@/components/schema-visualizer";
import { SimplifyGeometryPanel } from "@/components/simplify-geometry-panel";
import { TileBuildStatus } from "@/components/tile-build-status";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchAllEntryRows, useEntriesPages } from "@/lib/entries-pages";
import {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "@/lib/export";
import { fetchAllGeometryRows, resolveGeometryRows } from "@/lib/geometry-rows";
import { layerSourceKind, useTileArchiveSource } from "@/lib/layer-source";
import { isSyncStale } from "@/lib/sync-staleness";

import { api } from "../../../../convex/_generated/api";

const entryPanelSearchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
  // Active tab ("overview" is the default and deliberately absent from the URL).
  view: z.enum(["overview", "entries", "history", "structure"]).optional(),
});

export const Route = createFileRoute("/datasets/$schemaId/")({
  component: SchemaDetailPage,
  validateSearch: entryPanelSearchSchema,
});

type Schema = NonNullable<FunctionReturnType<typeof api.schemas.get>>;
// `listGeometries` is paginated (see its doc comment in the component) — the
// per-item shape is still `PaginationResult["page"][number]`.
type Geometry = FunctionReturnType<typeof api.geometries.list>["page"][number];
// Entries stream in through `useEntriesPages` (`entries.listPage`, issue #54);
// per-row shape is one element of a page.
type Entry = FunctionReturnType<typeof api.entries.listPage>["page"][number];
type EntryPanelSearch = z.infer<typeof entryPanelSearchSchema>;

/** Display count: the denormalized total when the schema carries it, else what's loaded so far. */
function displayCount(entryCount: number | undefined, loadedCount: number): number {
  return entryCount ?? loadedCount;
}

/** Empty-dataset gate — reads the exact denormalized count, not just page 1. */
function datasetIsEmpty(entryCount: number | undefined, loadedCount: number): boolean {
  return displayCount(entryCount, loadedCount) === 0;
}

/**
 * Fetches this dataset's geometries — only when it's actually geospatial AND
 * the row path is serving it (`rowPath` false covers both the tile path —
 * issue #58 part 4: an above-threshold dataset's fresh archive renders the
 * map with zero geometry-row traffic — and the pending state where the
 * archive's metadata is still landing). `listGeometries` is paginated
 * server-side (a dataset's cumulative geometry payload can exceed Convex's
 * per-execution read-byte budget even though each row is safely under its own
 * document-size limit), so this fetches every page. `geometries` is
 * `undefined` only until the first rows exist; `isComplete` is the real
 * "everything is loaded" signal — a full pagination pass has finished, so the
 * array is the complete dataset. (`isLoading` alone drops back to false after
 * the first page, which is why the map's skeleton gate must key off
 * `isComplete`.)
 */
function useGeometriesForSchema(
  schema: Schema | null | undefined,
  schemaId: string,
  rowPath: boolean,
) {
  const shouldFetch = schema ? schema.kind === "geospatial" && rowPath : false,
    { isLoading, results, status } = useAllPaginated(
      api.geometries.list,
      shouldFetch ? { schemaId } : "skip",
    );
  return {
    geometries: isLoading ? undefined : results,
    isComplete: status === "Exhausted",
  };
}

/**
 * The full GeoJSON geometry already on file for `entryId`, looked up from
 * the schema's already-fetched geometries rather than a new query. Only
 * resolves the common inline case (`geometryJson`) synchronously — a
 * geometry stored externally (`geometryUrl`, the rare large-geometry case)
 * is left `undefined` here rather than kicking off an async fetch just to
 * pre-fill an edit textarea; the user can still paste a replacement.
 */
function findEntryGeometry(geometries: Geometry[] | undefined, entryId: string) {
  if (geometries === undefined) {
    return undefined;
  }
  const match = geometries.find((geometry) => geometry.entryId === entryId);
  if (match === undefined || match.geometryJson === undefined) {
    return undefined;
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `geometryJson` was validated as a real `Geometry` server-side at write time.
    return JSON.parse(match.geometryJson) as GeometryShape;
  } catch {
    return undefined;
  }
}

/** The entry an `edit` panel search targets, or `undefined` for a `create` panel (or a stale/deleted entryId). */
function resolveEntryForPanel(entries: Entry[], search: EntryPanelSearch): Entry | undefined {
  if (search.panel !== "edit" || search.entryId === undefined) {
    return undefined;
  }
  return entries.find((entry) => entry._id === search.entryId);
}

/**
 * The export's resolved-geometry map: the row path's already-resolved map
 * when it's serving the dataset, or — on the tile path (issue #58 part 4),
 * where geometry rows were never fetched for rendering — one on-demand
 * paginated fetch + resolve, materialized just for the export.
 */
async function resolveExportGeometries(
  tilePath: boolean,
  schemaId: string,
  rowPathResolved: globalThis.Map<string, GeometryShape>,
): Promise<globalThis.Map<string, GeometryShape>> {
  if (!tilePath) {
    return rowPathResolved;
  }
  return await resolveGeometryRows(await fetchAllGeometryRows(schemaId));
}

/**
 * The edit panel's prefill geometry: from the dataset's already-fetched rows
 * when the row path has them in hand; on the tile path (issue #58 part 4)
 * rows aren't fetched at all, so the on-demand single-entry read
 * (`getEntryGeometry`) fills in instead — an entry-detail read staying on
 * the row path, just lazily. Either way only the common inline case
 * (`geometryJson`) resolves; an externally-stored geometry is left
 * `undefined` rather than pre-fetched into the textarea (same as today).
 */
function resolveInitialGeometry(
  entry: Entry | undefined,
  geometries: Geometry[] | undefined,
  fetchedRow: Geometry | null | undefined,
): GeometryShape | undefined {
  if (entry === undefined) {
    return undefined;
  }
  if (geometries === undefined) {
    return fetchedRow === null || fetchedRow === undefined
      ? undefined
      : findEntryGeometry([fetchedRow], entry._id);
  }
  return findEntryGeometry(geometries, entry._id);
}

/**
 * Hosts the create/edit side panel — extracted so its target-resolution
 * ternaries don't count against the page's own complexity. Panel visibility
 * lives in the URL's search params so it survives a reload. Geometry prefill
 * reads the dataset's already-fetched rows when the row path has them; on
 * the tile path (issue #58 part 4) rows aren't fetched at all, so the one
 * entry's geometry loads on demand via `getEntryGeometry` instead — an
 * entry-detail read staying on the row path, just lazily.
 */
function EntryPanelHost({
  schemaId,
  schema,
  entries,
  geometries,
  search,
  onOpenChange,
}: {
  schemaId: string;
  schema: Schema;
  entries: Entry[];
  geometries: Geometry[] | undefined;
  search: EntryPanelSearch;
  onOpenChange: (open: boolean) => void;
}) {
  const loadedEntry = resolveEntryForPanel(entries, search),
    // Deep links (`?panel=edit&entryId=…`) can target a row the table hasn't
    // streamed to yet (issue #54) — the single-entry read resolves those. A
    // `null` result means the entry is gone and the panel stays closed, same
    // as a stale id did before pagination.
    fetchedEntry = useConvexQuery(
      api.entries.get,
      loadedEntry === undefined && search.panel === "edit" && search.entryId !== undefined
        ? { entryId: search.entryId }
        : "skip",
    ),
    entry = loadedEntry ?? (fetchedEntry ?? undefined),
    isOpen = search.panel === "create" || entry !== undefined,
    // The on-demand single-entry read, only while the panel targets an entry
    // AND the dataset's rows aren't in hand (the tile path). Deliberately on
    // the plain Convex subscription path, not the TanStack cache — geometry
    // payloads never enter the persisted-state system (part 5's invariant).
    fetchedRow = useConvexQuery(
      api.geometries.getEntryGeometry,
      isOpen && entry !== undefined && geometries === undefined ? { entryId: entry._id } : "skip",
    ),
    initialGeometry = resolveInitialGeometry(entry, geometries, fetchedRow);

  return (
    <EntryFormPanel
      schemaId={schemaId}
      schema={schema}
      entry={entry}
      initialGeometry={initialGeometry}
      open={isOpen}
      onOpenChange={onOpenChange}
    />
  );
}

/** Dismissible success banner shown right after a "Make geospatial" conversion completes. */
function ConversionSuccessAlert({
  result,
  onDismiss,
}: {
  result: { processed: number; total: number };
  onDismiss: () => void;
}) {
  return (
    <Alert variant="success" className="mb-6">
      <CheckCircle />
      <AlertTitle>This dataset is now geospatial</AlertTitle>
      <AlertDescription>
        Converted {result.processed} of {result.total} rows — each valid row got a Point geometry
        built from its coordinate columns. All original columns were kept.
      </AlertDescription>
      <AlertAction>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** "Make geospatial" action, only offered for a standard dataset that actually has entries to backfill geometry for. */
function MakeGeospatialButton({
  schema,
  entryCount,
  onClick,
}: {
  schema: Schema;
  entryCount: number;
  onClick: () => void;
}) {
  if (schema.kind === "geospatial" || entryCount === 0) {
    return null;
  }
  return (
    <Button variant="outline" onClick={onClick}>
      <MapPinned className="h-4 w-4 mr-2" />
      Make Geospatial
    </Button>
  );
}

function SchemaDetailPage() {
  const { schemaId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate(),
    // Light queries through the TanStack bridge (issue #58 part 5): the
    // dataset's schema and entries pages render from the persisted cache on a
    // cold start; the live WebSocket subscriptions update the same entries.
    schema = useQuery({ ...convexQuery(api.schemas.get, { schemaId }) }).data,
    // Entries stream in as server-side pages (issue #54) — one
    // `entries.listPage` query per cursor instead of one unbounded collect of
    // every row, so a 20k-row import can't hit the ~16 MiB per-execution
    // read cap. The table renders incrementally as pages resolve.
    entriesPages = useEntriesPages(schemaId),
    entries = entriesPages.entries,
    // Layer-source decision (issue #58 part 4): fresh tile archive → the map
    // renders from vector tiles and geometry rows are never fetched;
    // otherwise the row path applies exactly as before.
    sourceDecision = useTileArchiveSource(schema, schemaId),
    tilePath = layerSourceKind(sourceDecision) === "vector",
    rowPath = layerSourceKind(sourceDecision) === "rows",
    { geometries, isComplete } = useGeometriesForSchema(schema, schemaId, rowPath),
    resolvedGeometries = useResolvedGeometries(geometries ?? []),
    // The dataset's group, for the breadcrumb — skipped unless it's grouped
    // (also skips while `schema` itself is still loading, and yields null for
    // a dangling groupId whose group was deleted).
    group = useQuery({
      ...convexQuery(
        api.groups.get,
        schema !== null && schema !== undefined && schema.groupId !== undefined
          ? { groupId: schema.groupId }
          : "skip",
      ),
    }).data,
    [makeGeospatialOpen, setMakeGeospatialOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [simplifyOpen, setSimplifyOpen] = useState(false),
    [addToMapOpen, setAddToMapOpen] = useState(false),
    [jsonDefinitionOpen, setJsonDefinitionOpen] = useState(false),
    [conversionSuccess, setConversionSuccess] = useState<
      { processed: number; total: number } | undefined
    >(undefined),
    openCreatePanel = async () => {
      await navigate({ search: (prev) => ({ ...prev, panel: "create" }) });
    },
    openEditPanel = async (entry: Entry) => {
      await navigate({ search: (prev) => ({ ...prev, entryId: entry._id, panel: "edit" }) });
    },
    closePanel = async () => {
      await navigate({
        search: (prev) => ({ ...prev, entryId: undefined, panel: undefined }),
      });
    },
    // Tab switches write `?view=` so the active tab survives reloads and is
    // linkable; "overview" is the default and stays out of the URL. Panel
    // navigations above merge (not replace) so they never drop it.
    setView = async (view: "entries" | "history" | "overview" | "structure") => {
      await navigate({
        search: (prev) => ({ ...prev, view: view === "overview" ? undefined : view }),
      });
    },
    handleTabChange = (value: unknown) => {
      if (
        value === "entries" ||
        value === "history" ||
        value === "overview" ||
        value === "structure"
      ) {
        void setView(value);
      }
    },
    view = search.view ?? "overview",
    isGeospatialDataset = schema !== undefined && schema !== null && schema.kind === "geospatial",
    // A dataset synced from a connected external source is read-only here:
    // its rows are owned by the source's sync flow, so the write actions are
    // hidden (and the mutations they call are rejected server-side too).
    isBoundToSource = schema !== undefined && schema !== null && schema.source !== undefined,
    // Sync state of the bound dataset — last-synced time, staleness, and the
    // History tab all read from the binding (undefined while loading, null
    // for ordinary datasets).
    binding = useQuery({ ...convexQuery(api.bindings.getBySchema, { schemaId }) }).data,
    activeView = view === "history" && !isBoundToSource ? "overview" : view,
    // The retained original import file — menu action hidden until the
    // dataset actually has one.
    sourceFileUrl = useQuery({
      ...convexQuery(
        api.schemas.getSourceFileUrl,
        schema !== undefined && schema !== null && schema.sourceFileStorageId !== undefined
          ? { schemaId }
          : "skip",
      ),
    }).data,
    downloadSourceFile = async () => {
      if (!sourceFileUrl || !schema) {
        return;
      }
      // Same-site-but-different-port download: the `download` attribute is
      // ignored cross-origin, so fetch to a blob and save with the stored
      // filename (falling back to the slugified title).
      try {
        const res = await fetch(sourceFileUrl);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const blob = await res.blob(),
          url = URL.createObjectURL(blob),
          anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = schema.sourceFileName ?? `${slugify(schema.title)}-original`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        toast.error("Could not download the original file.");
      }
    },
    exportFormats: ExportFormatOption[] = isGeospatialDataset
      ? [
          {
            value: "geojson",
            label: "GeoJSON",
            hint: "One .geojson FeatureCollection — entries without geometry get null geometry.",
          },
          { value: "json", label: "JSON", hint: "Data entries as a .json file." },
          {
            value: "excel",
            label: "Excel (.xlsx)",
            hint: "One worksheet with the entries as rows.",
          },
        ]
      : [
          { value: "json", label: "JSON", hint: "Data entries as a .json file." },
          {
            value: "excel",
            label: "Excel (.xlsx)",
            hint: "One worksheet with the entries as rows.",
          },
        ],
    handleExportConfirm = async (format: ExportFormat, includeSchema: boolean) => {
      if (!schema) {
        return;
      }
      // An export always writes the WHOLE dataset, but the page only holds
      // the table's loaded pages (issue #54) — materialize every row on
      // demand instead of keeping the full set as a standing subscription.
      let exportEntries: Entry[];
      try {
        exportEntries = await fetchAllEntryRows(schemaId);
      } catch {
        toast.error("Could not load all rows for the export.");
        return;
      }
      const slug = slugify(schema.title),
        downloadSchemaFile = () => {
          if (includeSchema) {
            downloadText(JSON.stringify(schema.schema, null, 2), `${slug}-schema.json`);
          }
        },
        exportResolvedGeometries = await resolveExportGeometries(
          tilePath,
          schemaId,
          resolvedGeometries,
        );

      if (format === "geojson") {
        downloadText(
          JSON.stringify(
            buildGeoJsonCollection(exportEntries, exportResolvedGeometries, schemaId),
            null,
            2,
          ),
          `${slug}.geojson`,
        );
        downloadSchemaFile();
      } else if (format === "json") {
        downloadText(
          JSON.stringify(buildJsonPayload(schema.schema, exportEntries), null, 2),
          `${slug}.json`,
        );
        downloadSchemaFile();
      } else {
        await exportExcelWorkbook(
          [{ name: schema.title, rows: entryRows(exportEntries) }],
          `${slug}.xlsx`,
        );
      }
      toast.success("Export downloaded.");
    };

  if (schema === undefined || entriesPages.isLoading) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!schema) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Dataset Not Found</CardTitle>
          <CardDescription className="mb-4">
            The dataset you're looking for doesn't exist or has been deleted.
          </CardDescription>
          <RouterButton to="/datasets">Back to Datasets</RouterButton>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
      <div className="flex justify-between items-start mb-8">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/datasets" />}>Datasets</BreadcrumbLink>
              </BreadcrumbItem>
              {group != null && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={<Link to="/groups/$groupId" params={{ groupId: group._id }} />}
                    >
                      {group.name}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </>
              )}
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{schema.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-primary">{schema.title}</h1>
            {binding !== undefined && binding !== null && isSyncStale(binding) && (
              <Badge
                variant="destructive"
                title="The connected source changed after the last sync — sync from the dashboard to refresh."
              >
                Out of date
              </Badge>
            )}
          </div>
          <p className="text-lg text-muted-foreground mt-2">{schema.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isBoundToSource && (
            <RouterButton variant="outline" to="/datasets/$schemaId/edit" params={{ schemaId }}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </RouterButton>
          )}
          {!isBoundToSource && (
            <MakeGeospatialButton
              schema={schema}
              entryCount={displayCount(schema.entryCount, entries.length)}
              onClick={() => {
                setMakeGeospatialOpen(true);
              }}
            />
          )}
          <Button
            onClick={() => {
              setExportOpen(true);
            }}
            disabled={datasetIsEmpty(schema.entryCount, entries.length)}
            variant="outline"
          >
            <Download className="h-4 w-4 mr-2" />
            Export ({displayCount(schema.entryCount, entries.length)})
          </Button>
          {!isBoundToSource && (
            <RouterButton
              variant="outline"
              to="/datasets/$schemaId/bulk-upload"
              params={{ schemaId }}
            >
              <UploadCloud className="h-4 w-4 mr-2" />
              Bulk Upload
            </RouterButton>
          )}
          {!isBoundToSource && (
            <Button onClick={openCreatePanel}>
              <Plus className="h-4 w-4 mr-2" />
              Create Entry
            </Button>
          )}
          {(isGeospatialDataset || schema.sourceFileStorageId !== undefined) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label="More actions" />}
              >
                <Ellipsis className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isGeospatialDataset && (
                  <DropdownMenuItem
                    onClick={() => {
                      setAddToMapOpen(true);
                    }}
                  >
                    <MapIcon className="h-4 w-4 mr-2" />
                    Add to map…
                  </DropdownMenuItem>
                )}
                {isGeospatialDataset && !isBoundToSource && (
                  <DropdownMenuItem
                    onClick={() => {
                      setSimplifyOpen(true);
                    }}
                  >
                    <MapPinned className="h-4 w-4 mr-2" />
                    Simplify geometry…
                  </DropdownMenuItem>
                )}
                {schema.sourceFileStorageId !== undefined && (
                  <DropdownMenuItem
                    disabled={sourceFileUrl === undefined}
                    onClick={() => void downloadSourceFile()}
                  >
                    <FileDown className="h-4 w-4 mr-2" />
                    Download original file
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {conversionSuccess && (
        <ConversionSuccessAlert
          result={conversionSuccess}
          onDismiss={() => {
            setConversionSuccess(undefined);
          }}
        />
      )}

      {schema.kind === "geospatial" && (
        <section className="relative mb-6">
          <EntriesMap
            key={schemaId}
            entries={entries}
            geometries={geometries ?? []}
            isLoading={!isComplete}
            source={sourceDecision}
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the component maintains boundingBox as a fixed [minLon, minLat, maxLon, maxLat] (see `schemas.boundingBox` in packages/json-cms).
            initialBbox={schema.boundingBox as [number, number, number, number] | undefined}
            className="h-[420px]"
          />
          {/* Live tile-archive build state (issue #71): previously the state
          store existed with no surface — failed builds were invisible. */}
          <TileBuildStatus schemaId={schemaId} />
        </section>
      )}

      <Tabs value={activeView} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="entries">
            Data ({displayCount(schema.entryCount, entries.length)})
          </TabsTrigger>
          {isBoundToSource && binding !== undefined && binding !== null && (
            <TabsTrigger value="history">History</TabsTrigger>
          )}
          <TabsTrigger value="structure">Structure</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <DatasetOverview binding={binding ?? undefined} schema={schema} schemaId={schemaId} />
        </TabsContent>

        <TabsContent value="entries">
          <Card>
            <CardHeader>
              <CardTitle>Data ({displayCount(schema.entryCount, entries.length)})</CardTitle>
              <CardDescription>Data entries created from this schema</CardDescription>
            </CardHeader>
            <CardContent>
              {datasetIsEmpty(schema.entryCount, entries.length) ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FilePlus />
                    </EmptyMedia>
                    <EmptyTitle>No data yet</EmptyTitle>
                    <EmptyDescription>Add your first entry to this schema.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button onClick={openCreatePanel}>
                      <Plus className="h-4 w-4 mr-2" />
                      Create First Entry
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <EntriesTable
                  schemaId={schemaId}
                  schema={schema.schema}
                  properties={Object.keys(schema.schema.properties ?? {})}
                  entries={entries}
                  entryCount={schema.entryCount}
                  hasMore={entriesPages.canLoadMore}
                  isLoadingMore={entriesPages.isLoadingMore}
                  onLoadMore={entriesPages.loadMore}
                  isGeospatial={schema.kind === "geospatial"}
                  onEdit={openEditPanel}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {isBoundToSource && binding !== undefined && binding !== null && (
          <TabsContent value="history" className="space-y-6">
            <DatasetHistoryPanel binding={binding} />
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
              <SchemaVisualizer schema={schema.schema} />
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
                    <pre className="text-sm">{JSON.stringify(schema.schema, null, 2)}</pre>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>
      </Tabs>

      <EntryPanelHost
        schemaId={schemaId}
        schema={schema}
        entries={entries}
        geometries={geometries}
        search={search}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            void closePanel();
          }
        }}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        heading={`Export "${schema.title}" (${displayCount(schema.entryCount, entries.length)} entries)`}
        formatOptions={exportFormats}
        defaultFormat={isGeospatialDataset ? "geojson" : "json"}
        schemaLabel="dataset"
        onConfirm={handleExportConfirm}
      />

      <GeospatialConversionPanel
        schemaId={schemaId}
        columns={Object.keys(schema.schema.properties ?? {})}
        sampleRows={entries
          .map((entry) => entry.data)
          .filter(
            (data): data is Record<string, unknown> =>
              typeof data === "object" && data !== null && !Array.isArray(data),
          )}
        entryCount={displayCount(schema.entryCount, entries.length)}
        open={makeGeospatialOpen}
        onOpenChange={setMakeGeospatialOpen}
        onConversionComplete={setConversionSuccess}
      />

      {schema.kind === "geospatial" && (
        <SimplifyGeometryPanel
          alreadySimplified={schema.simplifyGeometry === true}
          featureCount={schema.featureCount ?? entries.length}
          open={simplifyOpen}
          onOpenChange={setSimplifyOpen}
          schemaId={schemaId}
          schemaTitle={schema.title}
        />
      )}

      {isGeospatialDataset && (
        <AddToMapSheet
          open={addToMapOpen}
          onOpenChange={setAddToMapOpen}
          target={{ targetId: schemaId, targetType: "dataset", targetName: schema.title }}
        />
      )}
    </div>
  );
}
