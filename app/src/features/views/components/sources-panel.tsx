import { nodeUsages, type ViewDefinition } from "@caden/data-core/views";
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
import { Popover, PopoverContent, PopoverTrigger } from "@caden/ui/components/popover";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { nodeLabel, withAddedSource, type InputInfo, type PickerDataset } from "../lib/view-model";

/**
 * The view's sources: the datasets (and views) it reads, one `source` node
 * each. Add one here, then read it from a node. A source nothing reads is
 * marked Unused; it can be removed, and it stays declared until then.
 */
export function SourcesPanel({
  datasets,
  definition,
  infos,
  onChange,
  onSelect,
}: {
  /** Everything that could be added (the catalog's datasets and views). */
  datasets: PickerDataset[];
  definition: ViewDefinition;
  infos: readonly InputInfo[];
  onChange: (next: ViewDefinition, added?: string) => void;
  onSelect: (id: string) => void;
}) {
  const usages = nodeUsages(definition),
    [open, setOpen] = useState(false),
    sources = Object.entries(definition.nodes).flatMap(([id, node]) =>
      node.kind === "source" ? [{ id, node }] : [],
    );
  const kindOf = (datasetId: string): string => {
    const dataset = datasets.find((entry) => entry.id === datasetId);
    return dataset !== undefined && dataset.kind === "view" ? "View" : "Dataset";
  };
  return (
    <section aria-label="Sources" className="flex flex-col gap-2 border-b px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Sources <span className="font-normal text-muted-foreground">({sources.length})</span>
        </h2>
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger render={<Button size="sm" type="button" variant="outline" />}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add source
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
                        const added = withAddedSource(definition, dataset);
                        onChange(added.definition, added.node);
                        setOpen(false);
                      }}
                      value={`${dataset.title} ${dataset.projectTitle ?? ""} ${dataset.id}`}
                    >
                      <span className="truncate">{dataset.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {dataset.kind === "view" ? "View" : "Dataset"}
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
        {sources.map(({ id, node }) => {
          const readers = (usages.get(id) ?? []).map((usage) => usage.label);
          const title = nodeLabel(definition, infos, id);
          return (
            <li className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" key={id}>
              <button
                className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                onClick={() => {
                  onSelect(id);
                }}
                title={`${title} (${id})`}
                type="button"
              >
                {title}
              </button>
              <Badge variant="outline">{kindOf(node.ref.id)}</Badge>
              {readers.length === 0 ? (
                <Badge variant="secondary">Unused</Badge>
              ) : (
                <span
                  className="max-w-32 truncate text-xs text-muted-foreground"
                  title={readers.join(", ")}
                >
                  Read by {readers.join(", ")}
                </span>
              )}
              <Button
                aria-label={`Remove ${title}`}
                disabled={readers.length > 0}
                onClick={() => {
                  const { [id]: _removed, ...rest } = definition.nodes;
                  onChange({ ...definition, nodes: rest });
                }}
                size="icon-sm"
                title={readers.length > 0 ? `Read by ${readers.join(", ")}.` : "Remove this source"}
                type="button"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
