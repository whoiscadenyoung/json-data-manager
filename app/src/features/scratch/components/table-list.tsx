import { Card, CardContent, CardHeader, CardTitle } from "@caden/ui/components/card";

import type { ScratchTableInfo } from "#/features/views";

/**
 * The names the query can read, each with the dataset's title and fields.
 * Every table has the same shape: `row_id` (uuid), `d` (jsonb, the row's
 * properties: `d->>'field'`) and `geom` (geometry, nullable).
 */
export function TableList({ loading, tables }: { loading: boolean; tables: ScratchTableInfo[] }) {
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-base">Tables</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs">
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : tables.length === 0 ? (
          <p className="text-muted-foreground">
            This project has no datasets yet. Add or import one first.
          </p>
        ) : (
          tables.map((table) => (
            <div key={table.datasetId}>
              <p className="font-mono text-sm font-semibold break-all">{table.name}</p>
              <p className="text-muted-foreground">
                {table.title}
                {table.kind === "view" ? " (view)" : ""}
              </p>
              {table.fields.length > 0 && (
                <p className="mt-0.5 break-words text-muted-foreground">
                  {table.fields.join(", ")}
                </p>
              )}
            </div>
          ))
        )}
        <p className="border-t pt-2 text-muted-foreground">
          Columns: <code>row_id</code>, <code>d</code> (jsonb, e.g.{" "}
          <code>d-&gt;&gt;&apos;name&apos;</code>
          ), <code>geom</code>.
        </p>
      </CardContent>
    </Card>
  );
}
