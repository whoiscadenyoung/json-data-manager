import { Copy, Download, PackageOpen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import type { LayerStyle } from "#convex/layerStyles/validators";

import { exportStyleJson, importStyleJson, slugify } from "../lib/exchange";
import { loadCatalog } from "../lib/icon-images";
import { iconNamesOfStyle } from "../lib/icons";
import { buildSpriteZip } from "../lib/sprite-export";
import { Section } from "./controls";
import type { MarkerIcons } from "./marker-section";

function downloadJson(text: string, filename: string) {
  downloadBlob(new Blob([text], { type: "application/json" }), filename);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob),
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
  icons,
  onApply,
}: {
  style: LayerStyle;
  title: string;
  icons: MarkerIcons;
  onApply: (style: LayerStyle) => void;
}) {
  const exported = exportStyleJson(style, title),
    // `null` = showing the current style; a string = the person's unapplied edit.
    [draft, setDraft] = useState<string | null>(null),
    [errors, setErrors] = useState<string[]>([]),
    [packing, setPacking] = useState(false),
    usedIcons = iconNamesOfStyle(style),
    text = draft ?? exported;

  const apply = async () => {
    let builtIn: Set<string>;
    try {
      builtIn = new Set((await loadCatalog()).map((entry) => entry.name));
    } catch {
      setErrors(["Couldn't load the icon list to check this style's icons. Try again."]);
      return;
    }
    const result = importStyleJson(text, (name) => builtIn.has(name) || icons.uploads.has(name));
    if (result.ok) {
      onApply(result.style);
      setDraft(null);
      toast.success("Custom style applied.");
    } else {
      setErrors(result.errors);
    }
  };

  const downloadSprite = async () => {
    setPacking(true);
    try {
      const zip = await buildSpriteZip(style, title, icons.uploads);
      downloadBlob(zip.blob, zip.filename);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't build the sprite.");
    } finally {
      setPacking(false);
    }
  };
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
            void apply();
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
        {usedIcons.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={packing}
            onClick={() => {
              void downloadSprite();
            }}
          >
            <PackageOpen className="mr-1.5 size-3.5" />
            {packing ? "Packing…" : "Download sprite"}
          </Button>
        )}
      </div>
      {usedIcons.length > 0 && (
        <p className="text-xs text-muted-foreground">
          This style uses {usedIcons.length} icon{usedIcons.length === 1 ? "" : "s"}.{" "}
          <span className="font-medium">Download sprite</span> zips them as a MapLibre sprite (1x
          and 2x) with the layers, so the pair draws the same in another MapLibre app.
        </p>
      )}
    </Section>
  );
}
