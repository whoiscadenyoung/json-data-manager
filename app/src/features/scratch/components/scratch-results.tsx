import { Badge } from "@caden/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@caden/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@caden/ui/components/table";

import type { scratchQuery } from "@/lib/store/views";

type Outcome = Awaited<ReturnType<typeof scratchQuery>>["outcome"];

/** One cell as display text: structures print as JSON, never "[object Object]". */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** The result card: Postgres's message on failure, else count, timing and a table. */
export function ScratchResults({
  error,
  outcome,
  pending,
}: {
  error: string | undefined;
  outcome: Outcome;
  pending: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Result
          {outcome !== undefined && outcome.ok && (
            <>
              <Badge variant="secondary">
                {outcome.rowCount.toLocaleString()} {outcome.rowCount === 1 ? "row" : "rows"}
              </Badge>
              <Badge variant="outline">{outcome.elapsedMs} ms</Badge>
              {outcome.truncated && (
                <Badge title="The query returned more rows than the cap." variant="outline">
                  Truncated at {outcome.rowCount.toLocaleString()} rows
                </Badge>
              )}
            </>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResultBody error={error} outcome={outcome} pending={pending} />
      </CardContent>
    </Card>
  );
}

function ResultBody({
  error,
  outcome,
  pending,
}: {
  error: string | undefined;
  outcome: Outcome;
  pending: boolean;
}) {
  if (pending) {
    return <p className="text-sm text-muted-foreground">Running on the server…</p>;
  }
  const message = error ?? (outcome !== undefined && !outcome.ok ? outcome.error : undefined);
  if (message !== undefined) {
    return (
      <p
        className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-sm whitespace-pre-wrap text-destructive"
        role="alert"
      >
        {message}
      </p>
    );
  }
  if (outcome === undefined || !outcome.ok) {
    return <p className="text-sm text-muted-foreground">Run the query to see its result here.</p>;
  }
  if (outcome.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">The query returned no rows.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {outcome.columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {outcome.rows.map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- positional query output, replaced wholesale on re-run.
            <TableRow key={index}>
              {outcome.columns.map((column) => (
                <TableCell key={column} className="max-w-72 truncate font-mono text-xs">
                  {cellText(row[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
