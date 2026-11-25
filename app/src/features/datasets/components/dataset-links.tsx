import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, KeyRound, Loader2, MapPinned, Plus, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { createProjectView, definitionFromRelation } from "#/features/views";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import type { DatasetRow } from "@/lib/store/datasets";
import * as relationsStore from "@/lib/store/relations";
import type { DatasetRelationRow } from "@/lib/store/relations";

import { suggestKeys } from "../lib/link-suggestions";

/**
 * The dataset page's Related tab: the LINKS declared on this dataset. A link
 * (stored as a dataset relation) only powers map clicks: the linked features
 * highlight and are listed in the popup. Joining data into columns is a
 * view's job. Either end may be a saved view; a live view saves no rows, so it
 * can't be linked (the database refuses it too, migration 0035).
 */

type LinkKind = "key" | "spatial";

function keyConfigOf(link: DatasetRelationRow): { fromKey: string; toKey: string } | undefined {
  const config: unknown = link.config;
  if (link.kind !== "key" || typeof config !== "object" || config === null) {
    return undefined;
  }
  const record = new globalThis.Map(Object.entries(config));
  const fromKey = record.get("fromKey");
  const toKey = record.get("toKey");
  return typeof fromKey === "string" && typeof toKey === "string" ? { fromKey, toKey } : undefined;
}

function summaryOf(link: DatasetRelationRow): string {
  const key = keyConfigOf(link);
  if (key !== undefined) {
    return `${key.fromKey} → ${key.toKey}`;
  }
  const config: unknown = link.config;
  if (typeof config !== "object" || config === null) {
    return "";
  }
  const record = new globalThis.Map(Object.entries(config));
  return `${String(record.get("predicate") ?? "?")} · ${String(record.get("direction") ?? "?")}`;
}

function titleOf(byId: globalThis.Map<string, DatasetRow>, id: string): string {
  const row = byId.get(id);
  return row === undefined ? "Unknown dataset" : row.title;
}

/** True for a dataset that can sit at a link end (not a live view). */
function linkable(dataset: DatasetRow): boolean {
  return !(dataset.kind === "view" && dataset.refreshMode === "live");
}

export function DatasetLinks({
  canEdit,
  dataset,
  projectId,
}: {
  canEdit: boolean;
  dataset: DatasetRow;
  /** The enclosing project (a link's "Create view" needs one); null on standalone pages. */
  projectId: string | null;
}) {
  const queryClient = useQueryClient(),
    linksQuery = useQuery(relationsStore.listForDatasetsQueryOptions({ datasetIds: [dataset.id] })),
    datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    byId = new globalThis.Map((datasetsQuery.data ?? []).map((row) => [row.id, row])),
    invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["relations"] });
      void queryClient.invalidateQueries({ queryKey: ["views"] });
      void queryClient.invalidateQueries({ queryKey: ["datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", "catalog"] });
    },
    links = linksQuery.data ?? [],
    selfLinkable = linkable(dataset);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Links</CardTitle>
          <CardDescription>
            Links tell a map which records belong together: click a feature and its linked features
            highlight and are listed in the popup. To put another dataset's columns on these rows,
            build a view instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {links.length === 0 ? (
            <p className="text-sm text-muted-foreground">No links on this dataset yet.</p>
          ) : (
            links.map((link) => (
              <LinkRow
                byId={byId}
                canEdit={canEdit}
                invalidate={invalidate}
                key={link.id}
                link={link}
                projectId={projectId}
              />
            ))
          )}
        </CardContent>
      </Card>
      {canEdit &&
        (selfLinkable ? (
          <AddLinkCard
            candidates={(datasetsQuery.data ?? []).filter(
              (row) => row.id !== dataset.id && linkable(row),
            )}
            dataset={dataset}
            onCreated={invalidate}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            A live view saves no rows, so it can't be linked. Switch it to manual or auto refresh
            first.
          </p>
        ))}
    </div>
  );
}

function LinkRow({
  byId,
  canEdit,
  invalidate,
  link,
  projectId,
}: {
  byId: globalThis.Map<string, DatasetRow>;
  canEdit: boolean;
  invalidate: () => void;
  link: DatasetRelationRow;
  projectId: string | null;
}) {
  const [busy, setBusy] = useState<string>(),
    navigate = useNavigate(),
    fromTitle = titleOf(byId, link.fromDataset),
    toTitle = titleOf(byId, link.toDataset),
    key = keyConfigOf(link),
    createView = async (): Promise<void> => {
      if (projectId === null || key === undefined) {
        return;
      }
      setBusy("view");
      try {
        const seeded = definitionFromRelation({
          cardinality: link.cardinality,
          fromDataset: link.fromDataset,
          fromKey: key.fromKey,
          fromTitle,
          toDataset: link.toDataset,
          toKey: key.toKey,
          toTitle,
        });
        const viewId = await createProjectView({
          definition: seeded.definition,
          projectId,
          title: seeded.title,
        });
        toast.success("View created from the link. Run it to fill in its rows.");
        invalidate();
        void navigate({ params: { projectId, viewId }, to: "/projects/$projectId/views/$viewId" });
      } catch (error) {
        toast.error(errorMessage(error, "Failed to create the view."));
      } finally {
        setBusy(undefined);
      }
    },
    remove = async (): Promise<void> => {
      setBusy("remove");
      try {
        await relationsStore.remove({ relationId: link.id });
        toast.success("Link removed.");
        invalidate();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to remove the link."));
      } finally {
        setBusy(undefined);
      }
    };
  return (
    <div className="flex items-center gap-4 rounded-lg border px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {link.kind === "key" ? (
              <KeyRound className="h-3 w-3" />
            ) : (
              <MapPinned className="h-3 w-3" />
            )}
            {link.kind === "key" ? "Key" : "Spatial"}
          </Badge>
          <Badge title="How many records match each way." variant="outline">
            {link.cardinality}
          </Badge>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{fromTitle}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{toTitle}</span>
        </p>
        <p className="text-xs text-muted-foreground">{summaryOf(link)}</p>
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-1.5">
          {key !== undefined && projectId !== null && (
            <Button
              disabled={busy !== undefined}
              onClick={() => {
                void createView();
              }}
              size="sm"
              title="Start a view that joins these two datasets on this link's keys."
              variant="outline"
            >
              {busy === "view" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Workflow className="mr-1 h-3.5 w-3.5" />
              )}
              Create view from link
            </Button>
          )}
          <Button
            aria-label="Remove link"
            className="text-muted-foreground hover:text-destructive"
            disabled={busy !== undefined}
            onClick={() => {
              void remove();
            }}
            size="icon"
            title="Remove the link (the datasets stay untouched)"
            variant="ghost"
          >
            {busy === "remove" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function AddLinkCard({
  candidates,
  dataset,
  onCreated,
}: {
  candidates: DatasetRow[];
  dataset: DatasetRow;
  onCreated: () => void;
}) {
  const [toId, setToId] = useState(""),
    [kind, setKind] = useState<LinkKind>("key"),
    [fromKey, setFromKey] = useState(""),
    [toKey, setToKey] = useState(""),
    [pending, setPending] = useState(false),
    other = candidates.find((row) => row.id === toId),
    otherProps = other === undefined ? [] : other.properties,
    suggestions = suggestKeys(dataset.properties, otherProps),
    pick = (id: string): void => {
      setToId(id);
      const next = candidates.find((row) => row.id === id),
        first = suggestKeys(dataset.properties, next === undefined ? [] : next.properties)[0];
      setFromKey(first === undefined ? "" : first.fromKey);
      setToKey(first === undefined ? "" : first.toKey);
    },
    ready = toId !== "" && (kind === "spatial" || (fromKey !== "" && toKey !== "")),
    add = async (): Promise<void> => {
      setPending(true);
      try {
        const row = await relationsStore.create({
          cardinality: kind === "key" ? "1-N" : "N-M",
          config:
            kind === "key" ? { fromKey, toKey } : { direction: "forward", predicate: "within" },
          fromDataset: dataset.id,
          kind,
          toDataset: toId,
        });
        if (row === null) {
          toast.error("The link didn't land: you may not be able to edit both datasets.");
          return;
        }
        toast.success("Link added.");
        setToId("");
        setFromKey("");
        setToKey("");
        onCreated();
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setPending(false);
      }
    },
    fieldSelect = (
      label: string,
      value: string,
      options: readonly string[],
      onChange: (next: string) => void,
    ) => (
      <div className="flex flex-1 flex-col gap-1.5">
        <p className="text-sm font-semibold">{label}</p>
        <Select
          onValueChange={(next) => {
            if (next !== null) {
              onChange(next);
            }
          }}
          value={value}
        >
          <SelectTrigger aria-label={label} className="w-full">
            <SelectValue placeholder="Pick a field">{value === "" ? undefined : value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a link</CardTitle>
        <CardDescription>Link {dataset.title} to another dataset or view.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-end gap-3">
          <div className="flex flex-[2] flex-col gap-1.5">
            <p className="text-sm font-semibold">Link to</p>
            <Select
              onValueChange={(value) => {
                if (value !== null) {
                  pick(value);
                }
              }}
              value={toId}
            >
              <SelectTrigger aria-label="Link to" className="w-full">
                <SelectValue placeholder="Pick a dataset or view">
                  {other === undefined ? undefined : other.title}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {candidates.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.title}
                    {row.kind === "view" ? " (view)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <p className="text-sm font-semibold">Kind</p>
            <Select
              onValueChange={(value) => {
                if (value === "key" || value === "spatial") {
                  setKind(value);
                }
              }}
              value={kind}
            >
              <SelectTrigger aria-label="Kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="key">Key (matching field)</SelectItem>
                <SelectItem value="spatial">Spatial (within)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {kind === "key" && toId !== "" && (
          <>
            <div className="flex items-end gap-3">
              {fieldSelect(`Field on ${dataset.title}`, fromKey, dataset.properties, setFromKey)}
              {fieldSelect(
                `Field on ${other === undefined ? "the other" : other.title}`,
                toKey,
                otherProps,
                setToKey,
              )}
            </div>
            {suggestions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Suggested:
                {suggestions.map((suggestion) => (
                  <Button
                    key={`${suggestion.fromKey}:${suggestion.toKey}`}
                    onClick={() => {
                      setFromKey(suggestion.fromKey);
                      setToKey(suggestion.toKey);
                    }}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {suggestion.fromKey === suggestion.toKey
                      ? suggestion.fromKey
                      : `${suggestion.fromKey} → ${suggestion.toKey}`}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                These datasets share no field names. Pick the fields by hand.
              </p>
            )}
          </>
        )}
        <Button
          className="w-fit"
          disabled={!ready || pending}
          onClick={() => {
            void add();
          }}
        >
          {pending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Add link
        </Button>
      </CardContent>
    </Card>
  );
}
