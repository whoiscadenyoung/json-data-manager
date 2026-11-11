import { Loader2 } from "lucide-react";

import { LabeledSelect } from "./labeled-select";

/**
 * The refresh mode picker of the view header (issue #305; docs/views-design.md
 * §7): what each mode does, in plain words, plus the "next refresh queued"
 * note for `auto`.
 */

export type RefreshMode = "manual" | "auto" | "live";

export const REFRESH_MODE_OPTIONS: { value: RefreshMode; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "auto", label: "Auto" },
  { value: "live", label: "Live" },
];

export const REFRESH_MODE_HELP: Record<RefreshMode, string> = {
  manual: "Rows are saved when you press Refresh now. Nothing changes until then.",
  auto: "Rows are re-saved about a minute after an input changes, as the person who turned Auto on. If they lose access, the refresh fails and the last good rows stay.",
  live: "Nothing is saved: the rows are computed from the inputs every time they are read, with your access, up to a row cap. Exports run the view once and save that snapshot.",
};

/** "in 40 seconds" / "in 3 minutes" / "due now" for a due time. */
export function dueLabel(dueAt: string, now: number = Date.now()): string {
  const ms = new Date(dueAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 1000) {
    return "due now";
  }
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `in ${seconds} seconds` : `in ${Math.round(seconds / 60)} minutes`;
}

export function RefreshModeControl({
  autoRunsAs,
  busy,
  mode,
  onChange,
  queue,
}: {
  /** Who automatic runs execute as, when mode is auto ("you", or another editor). */
  autoRunsAs?: string;
  busy: boolean;
  mode: RefreshMode;
  onChange: (mode: RefreshMode) => void;
  queue: { dueAt: string; running: boolean } | null | undefined;
}) {
  return (
    <section
      aria-label="Refresh settings"
      className="flex flex-col gap-1.5"
      data-testid="refresh-mode"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Refresh</span>
        <LabeledSelect
          ariaLabel="Refresh mode"
          className="h-8 w-32"
          disabled={busy}
          onChange={(next) => {
            if (next === "manual" || next === "auto" || next === "live") {
              onChange(next);
            }
          }}
          options={REFRESH_MODE_OPTIONS}
          placeholder="Refresh mode"
          value={mode}
        />
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {mode === "auto" && queue !== undefined && queue !== null && (
          <span className="text-xs text-muted-foreground" data-testid="refresh-queued">
            {queue.running ? "Refreshing now…" : `Next refresh queued, ${dueLabel(queue.dueAt)}`}
          </span>
        )}
        {mode === "live" && (
          <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
            Computed on read
          </span>
        )}
      </div>
      <p className="max-w-2xl text-xs text-muted-foreground">
        {REFRESH_MODE_HELP[mode]}
        {mode === "auto" && autoRunsAs !== undefined && ` Runs as ${autoRunsAs}.`}
      </p>
    </section>
  );
}
