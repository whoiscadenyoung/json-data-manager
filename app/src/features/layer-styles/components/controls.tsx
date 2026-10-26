import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible";
import { Field, FieldLabel } from "#/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

/** Small form controls shared by the Style panel's sections. */

export function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <Field orientation="horizontal" className="justify-between">
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
      <input
        id={id}
        type="color"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-7 w-10 cursor-pointer rounded border border-input bg-transparent p-0.5"
      />
    </Field>
  );
}

export function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  format = String,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor={id} className="font-normal">
          {label}
        </FieldLabel>
        <span className="text-xs tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        className="w-full accent-primary"
      />
    </Field>
  );
}

export function SelectField({
  id,
  label,
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        disabled={disabled || options.length === 0}
        value={value === "" ? null : value}
        items={options}
        onValueChange={(next) => {
          if (typeof next === "string") {
            onChange(next);
          }
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** A collapsed-by-default section — how the panel keeps everything past basic symbology out of the way. */
export function Section({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-muted/50">
        <span className="min-w-0">
          <span className="block">{title}</span>
          {description !== undefined && (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {description}
            </span>
          )}
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform"
          style={{ rotate: open ? "180deg" : undefined }}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 px-4 pt-1 pb-5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A row of class swatches with labels — the editor's live legend preview. */
export function SwatchList({ items }: { items: ReadonlyArray<{ color: string; label: string }> }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={`${item.label}:${item.color}`} className="flex items-center gap-2 text-xs">
          <span
            className="inline-block size-3 shrink-0 rounded-sm border border-foreground/10"
            style={{ backgroundColor: item.color }}
          />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
