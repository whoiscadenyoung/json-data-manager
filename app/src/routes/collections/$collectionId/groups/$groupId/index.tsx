import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Layers } from "lucide-react";
import { toast } from "sonner";

import { api } from "#convex/_generated/api";
import { DatasetList } from "@/components/dataset-list";
import type { Dataset } from "@/components/dataset-list";
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

export const Route = createFileRoute("/collections/$collectionId/groups/$groupId/")({
  component: GroupDetailPage,
});

/**
 * A group's own page: every member dataset's geometries rendered together
 * on one map — points and shapes layered directly, one color per dataset —
 * so the group reads as a single layer of data, followed by the member
 * dataset list. The management surface (creating groups, adding datasets)
 * stays on the collection page.
 */
function GroupDetailPage() {
  const { collectionId, groupId } = Route.useParams(),
    group = useQuery(api.groups.get, { groupId }),
    collection = useQuery(api.collections.get, { collectionId }),
    groups = useQuery(api.groups.list, { collectionId }),
    allDatasets = useQuery(api.schemas.list),
    datasets = (allDatasets ?? []).filter((dataset) => dataset.groupId === groupId),
    geospatialSchemaIds = datasets
      .filter((dataset) => dataset.kind === "geospatial")
      .map((dataset) => dataset._id),
    // Feature-detail popups read entry properties; one query covers every
    // geospatial dataset in the group.
    entries = useQuery(
      api.entries.listEntriesForSchemas,
      geospatialSchemaIds.length > 0 ? { schemaIds: geospatialSchemaIds } : "skip",
    ),
    { geometries, loaders } = useGeometriesBySchemas(geospatialSchemaIds),
    setSchemaGroup = useMutation(api.collections.setSchemaGroup),
    setSchemaCollection = useMutation(api.collections.setSchemaCollection),
    handleMoveToGroup = async (dataset: Dataset, targetGroupId: string | null) => {
      try {
        await setSchemaGroup({ groupId: targetGroupId, schemaId: dataset._id });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to move dataset.");
      }
    },
    handleRemoveFromCollection = async (dataset: Dataset) => {
      try {
        await setSchemaCollection({ collectionId: null, schemaId: dataset._id });
        toast.success(`Removed "${dataset.title}" from the collection.`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to remove dataset.");
      }
    };

  if (
    group === undefined ||
    collection === undefined ||
    groups === undefined ||
    allDatasets === undefined
  ) {
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
          <Link to="/collections/$collectionId" params={{ collectionId }}>
            <Button>Back to Collection</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const hasGeospatialDatasets = geospatialSchemaIds.length > 0;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
      <div className="mb-8">
        <Breadcrumb className="mb-2">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/collections" />}>Collections</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink
                render={<Link to="/collections/$collectionId" params={{ collectionId }} />}
              >
                {collection ? collection.name : "Collection"}
              </BreadcrumbLink>
            </BreadcrumbItem>
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

      {hasGeospatialDatasets && (
        <section className="mb-8" aria-label="Combined map of the datasets in this group">
          {loaders}
          {geometries === undefined || entries === undefined ? (
            <div className="flex justify-center items-center h-[500px] rounded-lg border border-border">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : (
            <GroupMap datasets={datasets ?? []} geometries={geometries} entries={entries} />
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
            datasets={datasets ?? []}
            groups={groups}
            emptyLabel="No datasets in this group yet — add some from the collection page."
            onMoveToGroup={(dataset, targetGroupId) => {
              void handleMoveToGroup(dataset, targetGroupId);
            }}
            onRemoveFromCollection={(dataset) => {
              void handleRemoveFromCollection(dataset);
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
