import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * Export profiles (issue #303; migration 0030): named export settings on a
 * dataset. RLS follows the dataset (viewers read, editors manage), so these
 * are plain table reads and writes.
 */

export interface ExportProfileRow {
  id: string;
  datasetId: string;
  name: string;
  settings: unknown;
  createdAt: string;
}

const SELECT = "id,datasetId:dataset_id,name,settings,createdAt:created_at";

export function listExportProfilesQueryOptions(datasetId: string, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:export_profiles", datasetId],
    queryFn: async (): Promise<ExportProfileRow[]> =>
      await queryRows<ExportProfileRow>(
        clientOf(options)
          .from("export_profiles")
          .select(SELECT)
          .eq("dataset_id", datasetId)
          .order("created_at", { ascending: true }),
      ),
  });
}

export async function createExportProfile(
  args: { datasetId: string; name: string; settings: unknown },
  options?: StoreOptions,
): Promise<ExportProfileRow | null> {
  return await queryRow<ExportProfileRow>(
    clientOf(options)
      .from("export_profiles")
      .insert({ dataset_id: args.datasetId, name: args.name, settings: args.settings })
      .select(SELECT)
      .single(),
  );
}

/** Returns the affected row count (0 = denied or gone). */
export async function updateExportProfile(
  args: { id: string; name: string; settings: unknown },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("export_profiles")
      .update({ name: args.name, settings: args.settings })
      .eq("id", args.id)
      .select("id"),
  );
  return rows.length;
}

export async function deleteExportProfile(id: string, options?: StoreOptions): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("export_profiles").delete().eq("id", id).select("id"),
  );
  return rows.length;
}
