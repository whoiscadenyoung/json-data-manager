import type { AppendTag, Step } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Plus, Trash2 } from "lucide-react";

import { appendMembers } from "../lib/append-columns";
import { inputAliasOptions, type InputInfo } from "../lib/view-model";
import { AppendColumns } from "./append-columns";
import { LabeledSelect } from "./labeled-select";

type AppendStep = Extract<Step, { kind: "append" }>;

/** Tags are typed as text; digits-only text becomes a number (a fiscal year stays numeric). */
function parseTag(text: string): AppendTag | undefined {
  if (text === "") {
    return undefined;
  }
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

function tagText(tag: AppendTag | undefined): string {
  return tag === undefined || tag === null ? "" : String(tag);
}

function fieldsFor(infos: readonly InputInfo[], alias: string): string[] | undefined {
  const info = infos.find((entry) => entry.alias === alias);
  return info === undefined ? undefined : info.fields;
}

function titleFor(infos: readonly InputInfo[], alias: string): string {
  const info = infos.find((entry) => entry.alias === alias);
  return info === undefined ? alias : info.title;
}

/**
 * Stack: one table of the datasets whose rows are added together. The first
 * row is the rows already flowing into this step (the view's Start when this
 * is the first step); the others pick from the view's declared inputs. Each
 * row can stamp a tag (e.g. the fiscal year) into one field, and geometry
 * travels with every row.
 */
export function AppendForm({
  baseFields,
  baseTitle,
  infos,
  isFirstStep,
  onChange,
  step,
}: {
  /** Fields of the rows flowing in (undefined when unknown). */
  baseFields?: string[];
  baseTitle: string;
  infos: readonly InputInfo[];
  isFirstStep: boolean;
  onChange: (step: Step) => void;
  step: AppendStep;
}) {
  const setSource = (index: number, patch: Partial<AppendStep["sources"][number]>): void => {
    onChange({
      ...step,
      sources: step.sources.map((source, i) => (i === index ? { ...source, ...patch } : source)),
    });
  };
  const taken = step.sources.map((source) => source.input);
  const tagMissing =
    step.tagField !== undefined &&
    (step.baseTag === undefined || step.sources.some((source) => source.tag === undefined));
  const members = appendMembers(
    step,
    isFirstStep ? baseTitle : "Rows so far",
    baseFields,
    (alias) => fieldsFor(infos, alias),
    (alias) => titleFor(infos, alias),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="append-tag-field">Tag field (optional)</Label>
        <Input
          className="w-56"
          id="append-tag-field"
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...step, tagField: value === "" ? undefined : value });
          }}
          placeholder="fiscal_year"
          value={step.tagField ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>Datasets stacked together</Label>
        <div className="grid grid-cols-[1fr_6rem_2rem] items-center gap-2 text-xs text-muted-foreground">
          <span>Dataset</span>
          <span>Tag</span>
          <span />
        </div>
        <div className="grid grid-cols-[1fr_6rem_2rem] items-center gap-2">
          <span className="truncate text-sm" title={baseTitle}>
            {isFirstStep ? baseTitle : "Rows so far"}
            <span className="ml-1.5 rounded border px-1 text-[10px] text-muted-foreground">
              {isFirstStep ? "Start" : "Previous steps"}
            </span>
          </span>
          <Input
            aria-label="Tag for the first dataset"
            onChange={(event) => {
              onChange({ ...step, baseTag: parseTag(event.target.value) });
            }}
            placeholder="2022"
            value={tagText(step.baseTag)}
          />
          <span />
          {step.sources.map((source, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- sources are an ordered, unkeyed list.
            <div className="contents" key={index}>
              <LabeledSelect
                ariaLabel={`Stacked dataset ${index + 1}`}
                onChange={(alias) => {
                  setSource(index, { input: alias });
                }}
                options={inputAliasOptions(
                  infos,
                  taken.filter((alias) => alias !== source.input),
                )}
                placeholder="Pick an input"
                value={source.input}
              />
              <Input
                aria-label={`Tag for stacked dataset ${index + 1}`}
                onChange={(event) => {
                  setSource(index, { tag: parseTag(event.target.value) });
                }}
                placeholder="2023"
                value={tagText(source.tag)}
              />
              <Button
                aria-label={`Remove stacked dataset ${index + 1}`}
                onClick={() => {
                  onChange({ ...step, sources: step.sources.filter((_, i) => i !== index) });
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        {tagMissing && (
          <p className="text-xs text-muted-foreground">
            Rows from a dataset without a tag get no {step.tagField} value.
          </p>
        )}
        <Button
          className="w-fit"
          onClick={() => {
            onChange({ ...step, sources: [...step.sources, { input: "" }] });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-3.5 w-3.5" />
          Add dataset
        </Button>
        {infos.length < 2 && (
          <p className="text-xs text-muted-foreground">
            Add the datasets to stack to this view's Inputs first.
          </p>
        )}
      </div>
      <AppendColumns members={members} onChange={onChange} step={step} />
    </div>
  );
}
