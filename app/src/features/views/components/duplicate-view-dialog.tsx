import {
  copyTitle,
  remapReport,
  remapSources,
  sourceIds,
  validateViewDefinition,
} from "@caden/data-core/views";
import type { SourceRemap, ViewDefinition } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import { inputMetaQueryOptions, savedDefinitionQueryOptions } from "@/lib/store/view-reads";

import { createProjectView } from "../lib/create-view";
import { inputPickerOptions, inputRefsOf, toCompileMeta } from "../lib/view-model";
import type { InputInfo, PickerDataset } from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";

/**
 * Duplicate view (#307; docs/views-design.md §9): a copy of the definition
 * and output (labels included) as a new view owned by the project, titled
 * "<title> (copy)". Each input can optionally be pointed at another dataset
 * or view; the copy is validated with the real validator against the new
 * inputs' fields and the missing ones are listed per step BEFORE anything is
 * created. Export profiles are not copied, and the copy always starts in
 * manual refresh mode (auto/live are server-gated and never inherited).
 */
export function DuplicateViewDialog({
  datasets,
  onOpenChange,
  open,
  projectId,
  title,
  viewId,
}: {
  /** The datasets and views of the project (the pick-another-input choices). */
  datasets: PickerDataset[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  title: string;
  viewId: string;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Duplicate view</DialogTitle>
          <DialogDescription>
            Copies the nodes and the output (labels included) into a new view in this project. The
            copy starts with manual refresh and no export profiles.
          </DialogDescription>
        </DialogHeader>
        <DuplicateForm
          datasets={datasets}
          onDone={() => {
            onOpenChange(false);
          }}
          projectId={projectId}
          title={title}
          viewId={viewId}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The source nodes of a definition with the dataset each reads. */
function sourcesOf(definition: ViewDefinition): { id: string; datasetId: string }[] {
  return sourceIds(definition).flatMap((id) => {
    const node = definition.nodes[id];
    return node.kind === "source" ? [{ id, datasetId: node.ref.id }] : [];
  });
}

function infosOf(
  metas:
    | readonly { alias: string; datasetId: string; title: string | null; fields: string[] }[]
    | undefined,
): InputInfo[] {
  return (metas ?? []).map((meta) => ({
    alias: meta.alias,
    datasetId: meta.datasetId,
    title: meta.title === null ? "A dataset you can't see" : meta.title,
    fields: meta.fields,
  }));
}

function DuplicateForm({
  datasets,
  onDone,
  projectId,
  title,
  viewId,
}: {
  datasets: PickerDataset[];
  onDone: () => void;
  projectId: string;
  title: string;
  viewId: string;
}) {
  const [newTitle, setNewTitle] = useState(copyTitle(title)),
    [picks, setPicks] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    navigate = useNavigate(),
    queryClient = useQueryClient(),
    saved = useQuery(savedDefinitionQueryOptions(viewId)),
    parsed =
      saved.data === null || saved.data === undefined
        ? undefined
        : validateViewDefinition(saved.data.definition),
    original: ViewDefinition | undefined =
      parsed !== undefined && parsed.ok ? parsed.value : undefined,
    originalMeta = useQuery({
      ...inputMetaQueryOptions(original === undefined ? [] : inputRefsOf(original)),
      placeholderData: keepPreviousData,
    }),
    oldInfos = infosOf(originalMeta.data);
  const sources = original === undefined ? [] : sourcesOf(original),
    remaps: SourceRemap[] = sources.map((source) => {
      const old = oldInfos.find((info) => info.alias === source.id);
      return {
        node: source.id,
        datasetId: picks[source.id] ?? source.datasetId,
        oldTitle: old === undefined ? "" : old.title,
      };
    }),
    remapped = original === undefined ? undefined : remapSources(original, remaps),
    changedAliases = remaps
      .filter((remap) =>
        sources.some((source) => source.id === remap.node && source.datasetId !== remap.datasetId),
      )
      .map((remap) => remap.node),
    newMeta = useQuery({
      ...inputMetaQueryOptions(remapped === undefined ? [] : inputRefsOf(remapped)),
      placeholderData: keepPreviousData,
    }),
    newInfos = infosOf(newMeta.data),
    metaReady =
      remapped !== undefined &&
      newMeta.data !== undefined &&
      newMeta.data.length === sourceIds(remapped).length &&
      originalMeta.data !== undefined,
    report =
      remapped === undefined || !metaReady
        ? undefined
        : remapReport(remapped, toCompileMeta(newInfos));

  if (saved.isPending) {
    return <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />;
  }
  if (original === undefined) {
    return (
      <p className="text-sm text-destructive">The saved nodes of this view could not be read.</p>
    );
  }

  const missing =
    newTitle.trim() === ""
      ? "Give the copy a title."
      : report === undefined
        ? "Checking the sources…"
        : report.ok
          ? undefined
          : "Fix the problems above, or pick different sources.";

  const create = async (): Promise<void> => {
    if (report === undefined || !report.ok) {
      return;
    }
    setBusy(true);
    try {
      const id = await createProjectView({
        definition: report.definition,
        projectId,
        title: newTitle.trim(),
      });
      void queryClient.invalidateQueries({ queryKey: ["pg:views"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
      toast.success(`Created "${newTitle.trim()}". Open it and press Run to fill its rows.`);
      onDone();
      await navigate({
        params: { projectId, viewId: id },
        to: "/projects/$projectId/views/$viewId",
      });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't duplicate the view."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="duplicate-view-title">
          Title <span className="text-destructive">*</span>
        </Label>
        <Input
          id="duplicate-view-title"
          onChange={(event) => {
            setNewTitle(event.target.value);
          }}
          value={newTitle}
        />
      </div>
      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Sources</legend>
        <p className="text-xs text-muted-foreground">
          Keep each source, or read another dataset or view instead. The nodes are checked against
          the new source&apos;s fields.
        </p>
        {sources.map((source) => {
          const old = oldInfos.find((info) => info.alias === source.id);
          const label = old === undefined ? source.id : old.title;
          const value = picks[source.id] ?? source.datasetId;
          return (
            <div className="flex flex-col gap-1" key={source.id}>
              <Label>Reads {label}</Label>
              <LabeledSelect
                ariaLabel={`Input ${label}`}
                className="w-full"
                onChange={(next) => {
                  setPicks((current) => ({ ...current, [source.id]: next }));
                }}
                options={withCurrent(inputPickerOptions(datasets), source.datasetId, label)}
                placeholder="Pick a dataset or view"
                value={value}
              />
              {changedAliases.includes(source.id) && (
                <p className="text-xs text-muted-foreground">Changed from {label}.</p>
              )}
            </div>
          );
        })}
      </fieldset>
      {report !== undefined && !report.ok && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          data-testid="remap-problems"
          role="alert"
        >
          <p className="font-medium text-destructive">The copy would not work with these inputs:</p>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-destructive">
            {report.byNode.map((group) => (
              <li key={group.node}>
                <span className="font-medium">{group.node}:</span> {group.messages.join(" ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report !== undefined && report.ok && changedAliases.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="remap-ok">
          Every node checks out against the new sources.
        </p>
      )}
      {missing !== undefined && <p className="text-xs text-muted-foreground">{missing}</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          disabled={missing !== undefined || busy}
          onClick={() => {
            void create();
          }}
          type="button"
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create copy
        </Button>
      </div>
    </div>
  );
}

/** The options, plus the input's current dataset when the picker list does not hold it (so its title still shows). */
function withCurrent(
  options: { value: string; label: string; group: string }[],
  currentId: string,
  currentTitle: string,
): { value: string; label: string; group: string }[] {
  return options.some((option) => option.value === currentId)
    ? options
    : [...options, { value: currentId, label: currentTitle, group: "Datasets" }];
}
