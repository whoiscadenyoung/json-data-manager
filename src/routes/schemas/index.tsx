import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { RouterButton } from "#/components/router-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Calendar, FolderOpen, Plus } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";

export const Route = createFileRoute("/schemas/")({
  component: SchemasPage,
});

function SchemasPage() {
  const schemas = useQuery(api.schemas.list);

  if (schemas === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-primary mb-1">Your Schemas</h1>
          <p className="text-muted-foreground">Manage your JSON schemas and create data entries</p>
        </div>
        <RouterButton to="/schemas/create">
          <Plus className="h-4 w-4 mr-2" />
          Create Schema
        </RouterButton>
      </div>

      {schemas.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>No schemas yet</EmptyTitle>
            <EmptyDescription>Create a schema to start managing your JSON data.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RouterButton to="/schemas/create">
              <Plus className="h-4 w-4 mr-2" />
              Create your first schema
            </RouterButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {schemas.map((schema) => (
            <Card key={schema._id} className="hover:shadow-md transition-shadow">
              <CardHeader>
                <CardTitle className="text-xl">{schema.title}</CardTitle>
                <CardDescription>{schema.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center text-sm text-muted-foreground mb-4">
                  <Calendar className="h-4 w-4 mr-2" />
                  Created {new Date(schema._creationTime).toLocaleDateString()}
                </div>
                <RouterButton
                  className="w-full"
                  to="/schemas/$schemaId"
                  params={{ schemaId: schema._id }}
                >
                  View Details
                </RouterButton>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
