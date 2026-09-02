import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
  Calendar,
  Code2,
  Download,
  FilePlus,
  Pencil,
  Plus,
  UploadCloud,
  Workflow,
} from "lucide-react";

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

export const Route = createFileRoute("/datasets/$schemaId/")({
  component: SchemaDetailPage,
});

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
    schema = useQuery(api.schemas.get, { schemaId }),
    entries = useQuery(api.entries.list, { schemaId }),
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
          <RouterButton to="/datasets/$schemaId/create" params={{ schemaId }}>
            <Plus className="h-4 w-4 mr-2" />
            Create Entry
          </RouterButton>
        </div>
      </div>

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries">Entries ({entries.length})</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
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
                    <RouterButton to="/datasets/$schemaId/create" params={{ schemaId }}>
                      <Plus className="h-4 w-4 mr-2" />
                      Create First Entry
                    </RouterButton>
                  </EmptyContent>
                </Empty>
              ) : (
                <div className="space-y-3">
                  {entries.map((entry) => (
                    <Card key={entry._id} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4">
                        <div className="flex items-center text-sm text-muted-foreground mb-2">
                          <Calendar className="h-4 w-4 mr-2" />
                          {new Date(entry._creationTime).toLocaleString()}
                        </div>
                        <div className="text-sm font-mono bg-muted p-2 rounded overflow-x-auto mb-3">
                          {JSON.stringify(entry.data, null, 2).slice(0, 200)}
                          {JSON.stringify(entry.data).length > 200 && "..."}
                        </div>
                        <RouterButton
                          size="sm"
                          className="w-full"
                          to="/datasets/$schemaId/$entryId"
                          params={{ entryId: entry._id, schemaId }}
                        >
                          View Details
                        </RouterButton>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

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
    </div>
  );
}
