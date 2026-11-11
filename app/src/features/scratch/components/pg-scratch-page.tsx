import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { SqlEditor } from "@caden/ui/components/sql-editor";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Workflow } from "lucide-react";
import { useState } from "react";

import { referencedScratchTables, type ScratchTableInfo } from "#/features/views";
import { errorMessage } from "@/lib/errors";
import { scratchQuery } from "@/lib/store/views";

import { SaveAsViewSheet } from "./save-as-view-sheet";
import { ScratchResults } from "./scratch-results";
import { TableList } from "./table-list";

/**
 * The project's Scratch query pad (#306): raw Postgres SQL over the project's
 * datasets and views, run on the SERVER as you (read-only, timeout, row cap).
 * Nothing is saved. The tables are the compiler's input CTEs `in_<name>`, so
 * a query that works here runs unchanged as a view's `sql` step ("Save as
 * view").
 */

const STARTER = "-- Pick a table from the list, then press Run (Ctrl/Cmd+Enter)\nselect 1 as one";

export function PgScratchPage({ projectId }: { projectId: string }) {
  const [sql, setSql] = useState(""),
    [saving, setSaving] = useState(false),
    queryClient = useQueryClient(),
    tablesQuery = useQuery({
      queryKey: ["pg:scratch-tables", projectId],
      queryFn: async () => (await scratchQuery(projectId)).tables,
      staleTime: 30_000,
    }),
    tables: ScratchTableInfo[] = tablesQuery.data ?? [],
    schema = Object.fromEntries(tables.map((table) => [table.name, ["row_id", "d", "geom"]])),
    run = useMutation({
      mutationFn: async (text: string) => await scratchQuery(projectId, text),
      onSuccess: (result) => {
        queryClient.setQueryData(["pg:scratch-tables", projectId], result.tables);
      },
    }),
    outcome = run.data === undefined ? undefined : run.data.outcome,
    runNow = () => {
      if (!run.isPending) {
        run.mutate(sql);
      }
    },
    canSave =
      outcome !== undefined && outcome.ok && referencedScratchTables(sql, tables).length > 0;
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold text-primary">Scratch query</h1>
        <Badge
          title="Nothing on this page is saved. Save as view to keep a query."
          variant="outline"
        >
          Unsaved
        </Badge>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Read-only SQL (Postgres) over this project&apos;s datasets and views, run as you. Nothing
        here changes data and nothing is kept: to keep a result, save the query as a view.
      </p>
      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Query</CardTitle>
              <CardDescription>
                One SELECT (or WITH … SELECT). Results are capped at 1,000 rows.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <SqlEditor
                ariaLabel="Scratch SQL"
                onChange={setSql}
                onRun={runNow}
                placeholder={STARTER}
                schema={schema}
                value={sql}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={run.isPending || sql.trim() === ""}
                  onClick={runNow}
                  type="button"
                >
                  <Play className="h-4 w-4" />
                  {run.isPending ? "Running…" : "Run"}
                </Button>
                <Button
                  disabled={!canSave}
                  onClick={() => {
                    setSaving(true);
                  }}
                  title={
                    canSave
                      ? "Create a view with this query as its one SQL step."
                      : "Run a query that reads at least one table to save it as a view."
                  }
                  type="button"
                  variant="outline"
                >
                  <Workflow className="h-4 w-4" />
                  Save as view
                </Button>
              </div>
            </CardContent>
          </Card>
          <ScratchResults
            error={run.isError ? errorMessage(run.error, "The query could not be run.") : undefined}
            outcome={outcome}
            pending={run.isPending}
          />
        </div>
        <TableList loading={tablesQuery.isPending} tables={tables} />
      </div>
      <SaveAsViewSheet
        onOpenChange={setSaving}
        open={saving}
        projectId={projectId}
        sql={sql}
        tables={tables}
      />
    </main>
  );
}
