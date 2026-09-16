import type { Geometry as GeometryShape } from "@caden/json-cms/react";
import { useAllPaginated, useResolvedGeometries } from "@caden/json-cms/react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "@/lib/export";

import { api } from "../../../../convex/_generated/api";

const entryPanelSearchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
  // Active tab ("overview" is the default and deliberately absent from the URL).
  view: z.enum(["overview", "entries", "structure"]).optional(),
});

export const Route = createFileRoute("/datasets/$schemaId/")({
  component: SchemaDetailPage,
  validateSearch: entryPanelSearchSchema,
});

type Schema = NonNullable<FunctionReturnType<typeof api.schemas.get>>;
// `listGeometries` is paginated (see its doc comment in the component) — the
// per-item shape is still `PaginationResult["page"][number]`.
type Geometry = FunctionReturnType<typeof api.geometries.list>["page"][number];
type Entry = FunctionReturnType<typeof api.entries.list>[number];
type EntryPanelSearch = z.infer<typeof entryPanelSearchSchema>;

/**
 * Fetches this dataset's geometries — only when it's actually geospatial,
 * `"skip"` otherwise. `listGeometries` is paginated server-side (a dataset's
 * cumulative geometry payload can exceed Convex's per-execution read-byte
 * budget even though each row is safely under its own document-size limit),
 * so this fetches every page. `geometries` is `undefined` only until the
 * first rows exist; `isComplete` is the real "everything is loaded" signal —
 * a full pagination pass has finished, so the array is the complete dataset.
 * (`isLoading` alone drops back to false after the first page, which is why
 * the map's skeleton gate must key off `isComplete`.)
 */
function useGeometriesForSchema(schema: Schema | null | undefined, schemaId: string) {
  const shouldFetch = schema ? schema.kind === "geospatial" : false,
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

/** Hosts the create/edit side panel — extracted so its target-resolution ternaries don't count against the page's own complexity. Panel visibility lives in the URL's search params so it survives a reload. */
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
  const entry = resolveEntryForPanel(entries, search),
    isOpen = search.panel === "create" || entry !== undefined,
    initialGeometry = entry === undefined ? undefined : findEntryGeometry(geometries, entry._id);

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
    schema = useQuery(api.schemas.get, { schemaId }),
    entries = useQuery(api.entries.list, { schemaId }),
    { geometries, isComplete } = useGeometriesForSchema(schema, schemaId),
    resolvedGeometries = useResolvedGeometries(geometries ?? []),
    // The dataset's group, for the breadcrumb — skipped unless it's grouped
    // (also skips while `schema` itself is still loading, and yields null for
    // a dangling groupId whose group was deleted).
    group = useQuery(
      api.groups.get,
      schema?.groupId !== undefined ? { groupId: schema.groupId } : "skip",
    ),
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
    setView = async (view: "entries" | "overview" | "structure") => {
      await navigate({
        search: (prev) => ({ ...prev, view: view === "overview" ? undefined : view }),
      });
    },
    handleTabChange = (value: unknown) => {
      if (value === "entries" || value === "overview" || value === "structure") {
        void setView(value);
      }
    },
    view = search.view ?? "overview",
    isGeospatialDataset = schema !== undefined && schema !== null && schema.kind === "geospatial",
    // The retained original import file — menu action hidden until the
    // dataset actually has one.
    sourceFileUrl = useQuery(
      api.schemas.getSourceFileUrl,
      schema !== undefined && schema !== null && schema.sourceFileStorageId !== undefined
        ? { schemaId }
        : "skip",
    ),
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
      if (!schema || !entries) {
        return;
      }
      const slug = slugify(schema.title),
        downloadSchemaFile = () => {
          if (includeSchema) {
            downloadText(JSON.stringify(schema.schema, null, 2), `${slug}-schema.json`);
          }
        };

      if (format === "geojson") {
        downloadText(
          JSON.stringify(buildGeoJsonCollection(entries, resolvedGeometries, schemaId), null, 2),
          `${slug}.geojson`,
        );
        downloadSchemaFile();
      } else if (format === "json") {
        downloadText(
          JSON.stringify(buildJsonPayload(schema.schema, entries), null, 2),
          `${slug}.json`,
        );
        downloadSchemaFile();
      } else {
        await exportExcelWorkbook(
          [{ name: schema.title, rows: entryRows(entries) }],
          `${slug}.xlsx`,
        );
      }
      toast.success("Export downloaded.");
    };

  if (schema === undefined || entries === undefined) {
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
          <h1 className="text-3xl font-bold text-primary">{schema.title}</h1>
          <p className="text-lg text-muted-foreground mt-2">{schema.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RouterButton variant="outline" to="/datasets/$schemaId/edit" params={{ schemaId }}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </RouterButton>
          <MakeGeospatialButton
            schema={schema}
            entryCount={entries.length}
            onClick={() => {
              setMakeGeospatialOpen(true);
            }}
          />
          <Button
            onClick={() => {
              setExportOpen(true);
            }}
            disabled={entries.length === 0}
            variant="outline"
          >
            <Download className="h-4 w-4 mr-2" />
            Export ({entries.length})
          </Button>
          <RouterButton
            variant="outline"
            to="/datasets/$schemaId/bulk-upload"
            params={{ schemaId }}
          >
            <UploadCloud className="h-4 w-4 mr-2" />
            Bulk Upload
          </RouterButton>
          <Button onClick={openCreatePanel}>
            <Plus className="h-4 w-4 mr-2" />
            Create Entry
          </Button>
          {(isGeospatialDataset || schema.sourceFileStorageId !== undefined) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label="More actions" />}
              >
                <Ellipsis className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isGeospatialDataset && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        setAddToMapOpen(true);
                      }}
                    >
                      <MapIcon className="h-4 w-4 mr-2" />
                      Add to map…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSimplifyOpen(true);
                      }}
                    >
                      <MapPinned className="h-4 w-4 mr-2" />
                      Simplify geometry…
                    </DropdownMenuItem>
                  </>
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
        <section className="mb-6">
          <EntriesMap
            key={schemaId}
            entries={entries}
            geometries={geometries ?? []}
            isLoading={!isComplete}
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the component maintains boundingBox as a fixed [minLon, minLat, maxLon, maxLat] (see `schemas.boundingBox` in packages/json-cms).
            initialBbox={schema.boundingBox as [number, number, number, number] | undefined}
            className="h-[420px]"
          />
        </section>
      )}

      <Tabs value={view} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="entries">Data ({entries.length})</TabsTrigger>
          <TabsTrigger value="structure">Structure</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <DatasetOverview schema={schema} schemaId={schemaId} />
        </TabsContent>

        <TabsContent value="entries">
          <Card>
            <CardHeader>
              <CardTitle>Data ({entries.length})</CardTitle>
              <CardDescription>Data entries created from this schema</CardDescription>
            </CardHeader>
            <CardContent>
              {entries.length === 0 ? (
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
                  isGeospatial={schema.kind === "geospatial"}
                  onEdit={openEditPanel}
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
        heading={`Export "${schema.title}" (${entries.length} entries)`}
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
        entryCount={entries.length}
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
