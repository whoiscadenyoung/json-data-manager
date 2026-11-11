import type { CoordinateColumnGuess } from "@caden/data-core/coordinate-columns";
import type { CurrencyColumnGuess } from "@caden/data-core/currency";
import { Coins, MapPin, Sparkles } from "lucide-react";

import { Button } from "./primitives/button.js";

/** A suggestion's stable id: `currency:<field>` or `coordinates`. */
export type SuggestionId = `currency:${string}` | "coordinates";

export interface ImportSuggestionsProps {
  currency: readonly CurrencyColumnGuess[];
  /** The detected lat/lon pair, offered while the dataset is still "standard" (tabular rows only). */
  coordinates: CoordinateColumnGuess | undefined;
  /** Why a suggestion could not be applied (shown under it; nothing changed). */
  errors: Readonly<Record<string, string>>;
  onApplyCurrency: (field: string) => void;
  onUseCoordinates: () => void;
  onDismiss: (id: SuggestionId) => void;
}

function sampleNote(guess: CurrencyColumnGuess): string {
  const symbol = guess.symbol === null ? "" : ` (${guess.symbol})`;
  return `${guess.parsed.toLocaleString()} of ${guess.sampled.toLocaleString()} sampled values read as amounts${symbol}.`;
}

function CurrencySuggestion({
  guess,
  error,
  onApply,
  onDismiss,
}: {
  guess: CurrencyColumnGuess;
  error: string | undefined;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border bg-background px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Coins className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm">
          <code className="font-mono">{guess.field}</code> looks like currency
        </span>
        <span className="text-xs text-muted-foreground">{sampleNote(guess)}</span>
        <span className="ml-auto flex gap-1.5">
          {guess.mixedSymbols ? null : (
            <Button type="button" size="sm" variant="outline" onClick={onApply}>
              Type as number
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            Keep as text
          </Button>
        </span>
      </div>
      {guess.mixedSymbols ? (
        <p className="text-xs text-muted-foreground">
          It mixes currency symbols, so it can't be typed as one amount column. Split it in the
          file, or keep it as text.
        </p>
      ) : null}
      {error === undefined ? null : <p className="text-xs text-destructive">{error}</p>}
    </li>
  );
}

function CoordinateSuggestion({
  guess,
  onUse,
  onDismiss,
}: {
  guess: CoordinateColumnGuess;
  onUse: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm">
        Latitude/longitude in <code className="font-mono">{guess.latField}</code> /{" "}
        <code className="font-mono">{guess.lonField}</code>
      </span>
      <span className="text-xs text-muted-foreground">
        {guess.confidence === "high"
          ? "Matched by name and values."
          : "Matched the generic x/y names — check it's really coordinates."}
      </span>
      <span className="ml-auto flex gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={onUse}>
          Use as map points
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Keep as a table
        </Button>
      </span>
    </li>
  );
}

/**
 * The importer's Suggestions card (issue #291): per-column confirmations for
 * what the detectors found. Nothing applies on its own; "Keep as …" just
 * hides the suggestion, so declining everything imports the file unchanged.
 */
export function ImportSuggestions({
  currency,
  coordinates,
  errors,
  onApplyCurrency,
  onUseCoordinates,
  onDismiss,
}: ImportSuggestionsProps) {
  if (currency.length === 0 && coordinates === undefined) {
    return null;
  }
  return (
    <section
      aria-label="Import suggestions"
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="h-3.5 w-3.5" />
        Suggestions
        <span className="text-xs font-normal text-muted-foreground">
          Applying one rewrites that column and resets your unsaved edits to the schema below.
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {coordinates === undefined ? null : (
          <CoordinateSuggestion
            guess={coordinates}
            onUse={onUseCoordinates}
            onDismiss={() => {
              onDismiss("coordinates");
            }}
          />
        )}
        {currency.map((guess) => (
          <CurrencySuggestion
            key={guess.field}
            guess={guess}
            error={errors[`currency:${guess.field}`]}
            onApply={() => {
              onApplyCurrency(guess.field);
            }}
            onDismiss={() => {
              onDismiss(`currency:${guess.field}`);
            }}
          />
        ))}
      </ul>
    </section>
  );
}
