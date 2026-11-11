import type { Geometry } from "@caden/data-core/geojson";
import type { OutputSchema } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { fetchDatasetEntryRows, resolveDatasetGeometryRows } from "#/lib/dataset-rows-pg";
import { errorMessage } from "#/lib/errors";
import {
  createExportProfile,
  deleteExportProfile,
  listExportProfilesQueryOptions,
  updateExportProfile,
} from "#/lib/store/export-profiles";
import type { ExportProfileRow } from "#/lib/store/export-profiles";

import {
  defaultSettings,
  MAX_PRECISION,
  parseSettings,
  serializeExport,
} from "../lib/export-profile";
import type { ExportRow, ExportSettings } from "../lib/export-profile";
import { LabeledSelect } from "./labeled-select";

const FORMATS = [
  { value: "geojson", label: "GeoJSON" },
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
];
const NAMES = [
  { value: "keys", label: "Keys" },
  { value: "labels", label: "Labels" },
];
const EMPTY = [
  { value: "keep", label: "Keep (null)" },
  { value: "omit", label: "Omit" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function summary(settings: ExportSettings): string {
  const precision =
    settings.precision === null ? "full precision" : `${settings.precision} decimals`;
  return `${settings.format.toUpperCase()} · ${settings.propertyNames} · ${settings.emptyFields} empty · ${precision}`;
}

/** Reads the SAVED rows (the last run's snapshot) and writes them with the profile's settings. */
async function exportFromProfile(
  datasetId: string,
  title: string,
  output: OutputSchema,
  settings: ExportSettings,
  profileName: string,
): Promise<void> {
  const [entries, geometries] = await Promise.all([
    fetchDatasetEntryRows(datasetId),
    settings.format === "geojson"
      ? resolveDatasetGeometryRows(datasetId).then((resolved) => new globalThis.Map(resolved))
      : Promise.resolve(new globalThis.Map<string, Geometry>()),
  ]);
  // Geometry rows are 1:1 with entries and keyed by the entry id.
  const rows: ExportRow[] = entries.map((entry) => ({
    data: isRecord(entry.data) ? entry.data : {},
    geometry: geometries.get(entry.id) ?? null,
  }));
  const file = serializeExport(rows, output, settings);
  downloadBlob(
    new Blob([file.text], { type: file.mime }),
    `${slugify(title)}-${slugify(profileName)}.${file.extension}`,
  );
}

interface Draft {
  id: string | undefined;
  name: string;
  settings: ExportSettings;
}

/**
 * Export profiles on the view page (issue #303): named settings, and an
 * Export button per profile. Exports use the labels, order and hidden flags
 * of the SAVED definition and the last saved snapshot, never unsaved edits.
 */
export function ExportProfilesCard({
  datasetId,
  output,
  title,
}: {
  datasetId: string;
  output: OutputSchema;
  title: string;
}) {
  const queryClient = useQueryClient(),
    profiles = useQuery(listExportProfilesQueryOptions(datasetId)),
    [draft, setDraft] = useState<Draft | undefined>(),
    [busy, setBusy] = useState<string | undefined>(),
    refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:export_profiles", datasetId] });
    },
    guard = async (id: string, job: () => Promise<void>, fallback: string): Promise<void> => {
      setBusy(id);
      try {
        await job();
      } catch (error) {
        toast.error(errorMessage(error, fallback));
      } finally {
        setBusy(undefined);
      }
    },
    saveDraft = async (current: Draft): Promise<void> => {
      const name = current.name.trim();
      if (name === "") {
        toast.error("Name the profile first.");
        return;
      }
      await guard(
        "save",
        async () => {
          if (current.id === undefined) {
            await createExportProfile({ datasetId, name, settings: current.settings });
          } else if (
            (await updateExportProfile({ id: current.id, name, settings: current.settings })) === 0
          ) {
            throw new Error("You can't edit this profile.");
          }
          setDraft(undefined);
          refresh();
        },
        "Couldn't save the profile (names are unique per view).",
      );
    };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Export profiles</CardTitle>
        <CardDescription>
          Exports use the last saved rows and the saved output labels, order and hidden flags.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {profiles.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (profiles.data ?? []).length === 0 && draft === undefined ? (
          <p className="text-sm text-muted-foreground">No profiles yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {(profiles.data ?? []).map((profile: ExportProfileRow) => {
              const settings = parseSettings(profile.settings, output);
              return (
                <li className="flex flex-wrap items-center gap-2 py-2 text-sm" key={profile.id}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{profile.name}</p>
                    <p className="text-xs text-muted-foreground">{summary(settings)}</p>
                  </div>
                  <Button
                    disabled={busy !== undefined}
                    onClick={() => {
                      void guard(
                        profile.id,
                        async () => {
                          await exportFromProfile(datasetId, title, output, settings, profile.name);
                          toast.success("Export downloaded.");
                        },
                        "Couldn't export the saved rows.",
                      );
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Download className="mr-1 size-3.5" />
                    Export
                  </Button>
                  <Button
                    aria-label={`Edit ${profile.name}`}
                    onClick={() => {
                      setDraft({ id: profile.id, name: profile.name, settings });
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    aria-label={`Delete ${profile.name}`}
                    disabled={busy !== undefined}
                    onClick={() => {
                      void guard(
                        profile.id,
                        async () => {
                          await deleteExportProfile(profile.id);
                          refresh();
                        },
                        "Couldn't delete the profile.",
                      );
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {draft === undefined ? (
          <Button
            className="self-start"
            onClick={() => {
              setDraft({ id: undefined, name: "", settings: defaultSettings(output) });
            }}
            size="sm"
            variant="outline"
          >
            <Plus className="mr-1 size-3.5" />
            New profile
          </Button>
        ) : (
          <ProfileForm
            busy={busy === "save"}
            draft={draft}
            onCancel={() => {
              setDraft(undefined);
            }}
            onChange={setDraft}
            onSave={() => {
              void saveDraft(draft);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ProfileForm({
  busy,
  draft,
  onCancel,
  onChange,
  onSave,
}: {
  busy: boolean;
  draft: Draft;
  onCancel: () => void;
  onChange: (next: Draft) => void;
  onSave: () => void;
}) {
  const { settings } = draft;
  const patch = (next: Partial<ExportSettings>): void => {
    onChange({ ...draft, settings: { ...settings, ...next } });
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <Input
        aria-label="Profile name"
        onChange={(event) => {
          onChange({ ...draft, name: event.target.value });
        }}
        placeholder="Profile name, e.g. ArcGIS"
        value={draft.name}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledSelect
          ariaLabel="Format"
          onChange={(value) => {
            patch({ format: value === "csv" ? "csv" : value === "json" ? "json" : "geojson" });
          }}
          options={FORMATS}
          placeholder="Format"
          value={settings.format}
        />
        <LabeledSelect
          ariaLabel="Property names"
          onChange={(value) => {
            patch({ propertyNames: value === "labels" ? "labels" : "keys" });
          }}
          options={NAMES}
          placeholder="Property names"
          value={settings.propertyNames}
        />
        <LabeledSelect
          ariaLabel="Empty fields"
          onChange={(value) => {
            patch({ emptyFields: value === "omit" ? "omit" : "keep" });
          }}
          options={EMPTY}
          placeholder="Empty fields"
          value={settings.emptyFields}
        />
        <Input
          aria-label="Coordinate decimals"
          max={MAX_PRECISION}
          min={0}
          onChange={(event) => {
            const raw = event.target.value;
            const value = Number(raw);
            patch({
              precision:
                raw === "" || !Number.isInteger(value) || value < 0 || value > MAX_PRECISION
                  ? null
                  : value,
            });
          }}
          placeholder="Coordinate decimals (blank = all)"
          type="number"
          value={settings.precision === null ? "" : settings.precision}
        />
      </div>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={onSave} size="sm">
          Save profile
        </Button>
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}
