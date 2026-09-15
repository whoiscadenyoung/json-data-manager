import type { Geometry as GeometryShape } from "@caden/json-cms/react";
import { useAllPaginated } from "@caden/json-cms/react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Code2,
  Download,
  FilePlus,
  FolderTree,
  MapIcon,
  MapPinned,
  Pencil,
  Plus,
  UploadCloud,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { DatasetOrganizePanel } from "@/components/dataset-organize-panel";
import { EntriesMap } from "@/components/entries-map";
import { EntriesTable } from "@/components/entries-table";
import { EntryFormPanel } from "@/components/entry-form-panel";
import { GeospatialConversionPanel } from "@/components/geospatial-conversion-panel";
import { RouterButton } from "@/components/router-button";
import { SchemaVisualizer } from "@/components/schema-visualizer";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { api } from "../../../../convex/_generated/api";

const entryPanelSearchSchema = z.object({
  entryId: z.string().optional(),
  panel: z.enum(["create", "edit"]).optional(),
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
 * so this fetches every page and returns `undefined` until all of them have
 * loaded — matching the plain-`useQuery` shape the rest of this page expects.
 */
function useGeometriesForSchema(schema: Schema | null | undefined, schemaId: string) {
  const shouldFetch = schema ? schema.kind === "geospatial" : false,
    { isLoading, results } = useAllPaginated(
      api.geometries.list,
      shouldFetch ? { schemaId } : "skip",
    );
  return isLoading ? undefined : results;
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

/** Shows which collection/group this dataset belongs to, if any, each linking back to its page. */
function OrganizationBadge({ schema }: { schema: Schema }) {
  const collection = useQuery(
      api.collections.get,
      schema.collectionId ? { collectionId: schema.collectionId } : "skip",
    ),
    group = useQuery(api.groups.get, schema.groupId ? { groupId: schema.groupId } : "skip");

  if (!collection) {
    return null;
  }

  return (
    <p className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground">
      <FolderTree className="h-3.5 w-3.5" />
      <Link
        to="/collections/$collectionId"
        params={{ collectionId: collection._id }}
        className="hover:underline"
      >
        {collection.name}
      </Link>
      {group && <span>/ {group.name}</span>}
    </p>
  );
}

/** "N features with geometry" line — extracted so its `??`/ternary don't count against the page's own complexity. */
function FeatureCountBadge({ schema }: { schema: Schema }) {
  if (schema.kind !== "geospatial") {
    return null;
  }
  const count = schema.featureCount ?? 0;
  return (
    <p className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground">
      <MapIcon className="h-3.5 w-3.5" />
      {count} {count === 1 ? "feature" : "features"} with geometry
    </p>
  );
}

/** "Make geospatial" action, only offered for a standard dataset that actually has entries to backfill geometry for. */
function MakeGeospatialButton({ schema, entryCount, onClick }: { schema: Schema; entryCount: number; onClick: () => void }) {
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

function MapTabTrigger({ schema }: { schema: Schema }) {
  if (schema.kind !== "geospatial") {
    return null;
  }
  return <TabsTrigger value="map">Map</TabsTrigger>;
}

function MapTabContent({
  schema,
  geometries,
  entries,
}: {
  schema: Schema;
  geometries: Geometry[] | undefined;
  entries: Entry[];
}) {
  if (schema.kind !== "geospatial") {
    return null;
  }
  return (
    <TabsContent value="map">
      <EntriesMap geometries={geometries ?? []} entries={entries} />
    </TabsContent>
  );
}

/** Trigger a browser download of `content` as a file named `filename`. */
function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "application/json" }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function SchemaDetailPage() {
  const { schemaId } = Route.useParams(),
    search = Route.useSearch(),
    navigate = Route.useNavigate(),
    schema = useQuery(api.schemas.get, { schemaId }),
    entries = useQuery(api.entries.list, { schemaId }),
    geometries = useGeometriesForSchema(schema, schemaId),
    [organizeOpen, setOrganizeOpen] = useState(false),
    [makeGeospatialOpen, setMakeGeospatialOpen] = useState(false),
    openCreatePanel = async () => {
      await navigate({ search: { panel: "create" } });
    },
    openEditPanel = async (entry: Entry) => {
      await navigate({ search: { entryId: entry._id, panel: "edit" } });
    },
    closePanel = async () => {
      await navigate({ search: {} });
    },
    handleExport = () => {
      if (!entries || !schema) {
        return;
      }

      const slug = schema.title.toLowerCase().replaceAll(/\s+/g, "-"),
        schemaFilename = `${slug}-schema.json`;

      downloadFile(JSON.stringify(schema.schema, null, 2), schemaFilename);

      setTimeout(() => {
        const entriesData = {
          $schema: schemaFilename,
          entries: entries.map((entry) => entry.data),
        };
        downloadFile(JSON.stringify(entriesData, null, 2), `${slug}-entries.json`);
      }, 100);
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
          <Button
            variant="outline"
            onClick={() => {
              setOrganizeOpen(true);
            }}
          >
            <FolderTree className="h-4 w-4 mr-2" />
            Organize
          </Button>
          <MakeGeospatialButton
            schema={schema}
            entryCount={entries.length}
            onClick={() => {
              setMakeGeospatialOpen(true);
            }}
          />
          <Button onClick={handleExport} disabled={entries.length === 0} variant="outline">
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
        </div>
      </div>

      <OrganizationBadge schema={schema} />
      <FeatureCountBadge schema={schema} />

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries">Entries ({entries.length})</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <MapTabTrigger schema={schema} />
        </TabsList>

        <TabsContent value="entries">
          <Card>
            <CardHeader>
              <CardTitle>Entries ({entries.length})</CardTitle>
              <CardDescription>Data entries created from this schema</CardDescription>
            </CardHeader>
            <CardContent>
              {entries.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FilePlus />
                    </EmptyMedia>
                    <EmptyTitle>No entries yet</EmptyTitle>
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

        <MapTabContent schema={schema} geometries={geometries} entries={entries} />

        <TabsContent value="schema" className="space-y-6">
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

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Code2 className="h-5 w-5" />
                JSON Definition
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-muted rounded-lg p-4 overflow-x-auto">
                <pre className="text-sm">{JSON.stringify(schema.schema, null, 2)}</pre>
              </div>
            </CardContent>
          </Card>
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

      <DatasetOrganizePanel
        schemaId={schemaId}
        currentCollectionId={schema.collectionId}
        currentGroupId={schema.groupId}
        open={organizeOpen}
        onOpenChange={setOrganizeOpen}
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
      />
    </div>
  );
}
