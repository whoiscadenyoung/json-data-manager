import { Badge } from "@caden/ui/components/badge";
import { Card } from "@caden/ui/components/card";
import { Database, ExternalLink } from "lucide-react";

import { RouterButton } from "@/components/router-button";

import type { InputInfo } from "../lib/view-model";

/**
 * The settings panel for a selected input: what it is, how the view uses it
 * and the fields it brings. Its rows show in the preview panel. Inputs are
 * read-only here (they are edited on their own pages).
 */
export function InputDetail({
  info,
  projectId,
  role,
}: {
  /** Undefined while the input's metadata loads, or when it can't be read. */
  info: InputInfo | undefined;
  projectId: string;
  /** How the view uses it, e.g. "Starts from" or "Joined in step 2". */
  role: string;
}) {
  if (info === undefined) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading this input…</p>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Database className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{role}</p>
          <h2 className="truncate text-sm font-medium">{info.title}</h2>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          {info.fields.length === 0
            ? "Fields"
            : `${info.fields.length} ${info.fields.length === 1 ? "field" : "fields"}`}
        </p>
        {info.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Its fields aren't known yet. A view lists its fields after its first run.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {info.fields.map((field) => (
              <li key={field}>
                <Badge className="font-mono font-normal" variant="secondary">
                  {field}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The preview below shows this input's rows as the view reads them.
      </p>
      <RouterButton
        className="w-fit"
        params={{ projectId, schemaId: info.datasetId }}
        size="sm"
        to="/projects/$projectId/datasets/$schemaId"
        variant="outline"
      >
        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
        Open this dataset
      </RouterButton>
    </Card>
  );
}
