import { inputUsages, renameInputAlias, type ViewDefinition } from "@caden/data-core/views";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@caden/ui/components/command";
import { Input } from "@caden/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@caden/ui/components/popover";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { withAddedInput, type InputInfo, type PickerDataset } from "../lib/view-model";

const ALIAS_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * The view's inputs: the datasets (and views) it reads. Every other picker in
 * the editor offers only these. One input is the Start: the rows (and
 * geometry) the steps begin from. An input steps still read can't be removed.
 */
export function InputsPanel({
  datasets,
  definition,
  infos,
  onChange,
}: {
  /** Everything that could be added (the catalog's datasets and views). */
  datasets: PickerDataset[];
  definition: ViewDefinition;
  infos: readonly InputInfo[];
  onChange: (next: ViewDefinition) => void;
}) {
  const usages = inputUsages(definition),
    [open, setOpen] = useState(false);
  const titleOf = (alias: string): string => {
    const info = infos.find((entry) => entry.alias === alias);
    return info === undefined ? alias : info.title;
  };
  const kindOf = (datasetId: string): string => {
    const dataset = datasets.find((entry) => entry.id === datasetId);
    return dataset !== undefined && dataset.kind === "view" ? "View" : "Dataset";
  };
  const addable = datasets.filter(
    (dataset) => !definition.inputs.some((input) => input.ref.id === dataset.id),
  );
  return (
    <section aria-label="Inputs" className="flex flex-col gap-2 border-b px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Inputs{" "}
          <span className="font-normal text-muted-foreground">({definition.inputs.length})</span>
        </h2>
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger render={<Button size="sm" type="button" variant="outline" />}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add input
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96 p-0">
            <Command>
              <CommandInput placeholder="Search datasets and views" />
              <CommandList>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                <CommandGroup>
                  {datasets.map((dataset) => (
                    <CommandItem
                      key={dataset.id}
                      onSelect={() => {
                        onChange(withAddedInput(definition, dataset).definition);
                        setOpen(false);
                      }}
                      value={`${dataset.title} ${dataset.projectTitle ?? ""} ${dataset.id}`}
                    >
                      <span className="truncate">{dataset.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {dataset.kind === "view" ? "View" : "Dataset"}
                        {addable.some((entry) => entry.id === dataset.id) ? "" : " · added"}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <ul className="flex flex-col gap-1.5">
        {definition.inputs.map((input) => (
          <InputRow
            alias={input.alias}
            isStart={definition.base === input.alias}
            key={input.alias}
            kind={kindOf(input.ref.id)}
            onRemove={() => {
              onChange({
                ...definition,
                inputs: definition.inputs.filter((entry) => entry.alias !== input.alias),
              });
            }}
            onRename={(to) => {
              onChange(renameInputAlias(definition, input.alias, to));
            }}
            onStart={() => {
              onChange({ ...definition, base: input.alias });
            }}
            taken={definition.inputs.map((entry) => entry.alias)}
            title={titleOf(input.alias)}
            usedBy={(usages.get(input.alias) ?? [])
              .filter((usage) => usage.path !== "base")
              .map((usage) => usage.label)}
          />
        ))}
      </ul>
    </section>
  );
}

function InputRow({
  alias,
  isStart,
  kind,
  onRemove,
  onRename,
  onStart,
  taken,
  title,
  usedBy,
}: {
  alias: string;
  isStart: boolean;
  kind: string;
  onRemove: () => void;
  onRename: (to: string) => void;
  onStart: () => void;
  taken: string[];
  title: string;
  usedBy: string[];
}) {
  const [draft, setDraft] = useState(alias),
    valid = ALIAS_PATTERN.test(draft) && (draft === alias || !taken.includes(draft)),
    removeReason = isStart
      ? "Pick another Start first."
      : usedBy.length > 0
        ? `Used by ${usedBy.join(", ")}.`
        : undefined;
  return (
    <li className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <input
          aria-label={`Start from ${title}`}
          checked={isStart}
          name="view-start"
          onChange={onStart}
          title="Start: the rows (and geometry) the steps begin from"
          type="radio"
        />
        <span className="min-w-0 flex-1 truncate font-medium" title={title}>
          {title}
        </span>
        <Badge variant="outline">{kind}</Badge>
        {isStart && <Badge variant="secondary">Start</Badge>}
        <Button
          aria-label={`Remove ${title}`}
          disabled={removeReason !== undefined}
          onClick={onRemove}
          size="icon-sm"
          title={removeReason ?? "Remove this input"}
          type="button"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <Input
          aria-invalid={!valid}
          aria-label={`Alias for ${title}`}
          className="h-7 w-44 font-mono text-xs"
          onBlur={() => {
            if (valid && draft !== alias) {
              onRename(draft);
            } else {
              setDraft(alias);
            }
          }}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          title="The name steps and SQL use for this input"
          value={draft}
        />
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {usedBy.length === 0
            ? isStart
              ? "Starts the view"
              : "Unused"
            : `Used by ${usedBy.join(", ")}`}
        </span>
      </div>
    </li>
  );
}
