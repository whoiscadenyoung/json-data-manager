import { Copy, Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import type { LayerStyle } from "#convex/layerStyles/validators";

import { exportStyleJson, importStyleJson, slugify } from "../lib/exchange";
import { Section } from "./controls";

function downloadJson(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" })),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Style JSON copied.");
  } catch {
    toast.error("Couldn't copy — select the text and copy it instead.");
  }
}

/**
 * The transferability hatch: the style as MapLibre style-spec layers —
 * copy or download it into Maputnik, GeoLibre, QGIS's MapLibre import, or
 * any MapLibre app (point its `source` at your data), or paste MapLibre
 * layers back in. Applying replaces the simple editor's settings with a
 * custom style.
 */
export function AdvancedSection({
  style,
  title,
  onApply,
}: {
  style: LayerStyle;
  title: string;
  onApply: (style: LayerStyle) => void;
}) {
  const exported = exportStyleJson(style, title),
    // `null` = showing the current style; a string = the person's unapplied edit.
    [draft, setDraft] = useState<string | null>(null),
    [errors, setErrors] = useState<string[]>([]),
    text = draft ?? exported;
  return (
    <Section title="Advanced" description="MapLibre style JSON — copy, download, or paste">
      <p className="text-xs text-muted-foreground">
        These are standard MapLibre GL style layers. Use them in any MapLibre app by pointing{" "}
        <code className="rounded bg-muted px-1">source</code> at your data, or paste layers from
        another tool (one layer, a list, or a whole style.json) and apply them here.
      </p>
      <Textarea
        aria-label="MapLibre style JSON"
        value={text}
        spellCheck={false}
        rows={12}
        className="font-mono text-xs"
        onChange={(event) => {
          setDraft(event.target.value);
          setErrors([]);
        }}
      />
      {errors.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-destructive">
          {errors.slice(0, 5).map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={draft === null}
          onClick={() => {
            const result = importStyleJson(text);
            if (result.ok) {
              onApply(result.style);
              setDraft(null);
              toast.success("Custom style applied.");
            } else {
              setErrors(result.errors);
            }
          }}
        >
          Apply JSON
        </Button>
        {draft !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(null);
              setErrors([]);
            }}
          >
            Discard edits
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void copyText(exported);
          }}
        >
          <Copy className="mr-1.5 size-3.5" />
          Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            downloadJson(exported, `${slugify(title)}-style.json`);
          }}
        >
          <Download className="mr-1.5 size-3.5" />
          Download
        </Button>
      </div>
    </Section>
  );
}
