"use client";

import type { WidgetProps } from "@rjsf/utils";

import type { ReferenceCandidate } from "../../shared/reference.js";

export type { ReferenceCandidate } from "../../shared/reference.js";

function isCandidate(value: unknown): value is ReferenceCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    "label" in value &&
    typeof value.value === "string" &&
    typeof value.label === "string"
  );
}

function isCandidateArray(value: unknown): value is ReferenceCandidate[] {
  return Array.isArray(value) && value.every(isCandidate);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * RJSF widget for a foreign-reference field (see ../../shared/reference.ts).
 * Registered under the widget name `"reference"` — pair with
 * `buildReferenceUiSchema` (./reference-ui-schema.ts) to wire both the
 * widget selection and its candidate list into a form's `uiSchema`.
 *
 * Renders a single `<select>` for a `"one"`-cardinality field, or a checkbox
 * list for `"many"`. The candidate list comes entirely from
 * `ui:options.candidates` — this widget never queries data itself, so it
 * works the same whether the host app fetched candidates via Convex hooks or
 * plain `useQuery` calls.
 */
export function ReferenceWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, readonly, options } = props,
    candidates = isCandidateArray(options.candidates) ? options.candidates : [],
    isMultiple = options.cardinality === "many";

  if (candidates.length === 0) {
    return (
      <p className="text-xs italic text-muted-foreground" id={id}>
        No entries in the target dataset yet.
      </p>
    );
  }

  if (isMultiple) {
    const selected = asStringArray(value);
    return (
      <div
        id={id}
        className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-input p-2"
      >
        {candidates.map((c) => (
          <label key={c.value} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={selected.includes(c.value)}
              disabled={disabled || readonly}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...selected, c.value]
                  : selected.filter((v) => v !== c.value);
                onChange(next.length > 0 ? next : undefined);
              }}
            />
            {c.label}
          </label>
        ))}
      </div>
    );
  }

  return (
    <select
      id={id}
      value={typeof value === "string" ? value : ""}
      disabled={disabled || readonly}
      onChange={(e) => {
        onChange(e.target.value || undefined);
      }}
      className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <option value="">— none —</option>
      {candidates.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
