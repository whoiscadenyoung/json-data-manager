import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, queryScalar, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT } from "./datasets";

/**
 * The project folders store (migration 0034): the catalog's file-browser
 * tree. A folder belongs to one project and nests under another folder of
 * that project; it holds MEMBERSHIP rows (`project_artifacts.folder_id`),
 * never the artifacts themselves. Members read the tree, editors change it.
 *
 * Writes follow the store's silent-denial rule: an RLS-filtered write
 * answers 0 rows instead of throwing. The database's own refusals (a taken
 * name, a move into a descendant) throw with a readable message.
 *
 * Query keys sit under `projects`, so the project shell's `invalidateAll`
 * refreshes the tree with the catalog.
 */

/** One catalog folder. `parentId` null = the catalog root. */
export interface ProjectFolderRow {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const FOLDER_SELECT =
  "id,projectId:project_id,parentId:parent_id,name,createdAt:created_at,updatedAt:updated_at";

/** Every folder of one project (the whole tree is one small read). */
export function listFoldersQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["projects", "folders", args],
    queryFn: async () =>
      await queryRows<ProjectFolderRow>(
        clientOf(options)
          .from("project_folders")
          .select(FOLDER_SELECT)
          .eq("project_id", args.projectId)
          .order("name")
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

/** The trimmed name, or the validation every folder write shares. */
function folderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("A folder needs a name.");
  }
  return trimmed;
}

/** Runs one folder write, restating the database's refusals in the user's terms. */
async function refusalsReadable<T>(name: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("(23505)")) {
      throw new Error(
        name === undefined
          ? "A folder with the same name already exists there."
          : `A folder named “${name}” already exists there.`,
        { cause: error },
      );
    }
    if (message.includes("(23514)")) {
      throw new Error(message.replace(" (23514)", ""), { cause: error });
    }
    throw error;
  }
}

/** Creates a folder under `parentId` (null = the root). Returns the new row, or null when denied. */
export async function createFolder(
  args: { projectId: string; parentId: string | null; name: string },
  options?: StoreOptions,
): Promise<ProjectFolderRow | null> {
  const name = folderName(args.name);
  return await refusalsReadable(
    name,
    async () =>
      await queryRow<ProjectFolderRow>(
        clientOf(options)
          .from("project_folders")
          .insert({ name, parent_id: args.parentId, project_id: args.projectId })
          .select(FOLDER_SELECT)
          .single(),
      ),
  );
}

/** Renames a folder. Returns the affected row count. */
export async function renameFolder(
  args: { folderId: string; name: string },
  options?: StoreOptions,
): Promise<number> {
  const name = folderName(args.name);
  return await refusalsReadable(name, async () => {
    const rows = await queryRows<{ id: string }>(
      clientOf(options)
        .from("project_folders")
        .update({ name })
        .eq("id", args.folderId)
        .select("id"),
    );
    return rows.length;
  });
}

/** Moves a folder under `parentId` (null = the root). Returns the affected row count. */
export async function moveFolder(
  args: { folderId: string; parentId: string | null },
  options?: StoreOptions,
): Promise<number> {
  return await refusalsReadable(undefined, async () => {
    const rows = await queryRows<{ id: string }>(
      clientOf(options)
        .from("project_folders")
        .update({ parent_id: args.parentId })
        .eq("id", args.folderId)
        .select("id"),
    );
    return rows.length;
  });
}

/**
 * Deletes one folder and keeps what it holds: its subfolders and items move
 * up one level in the same transaction (`delete_project_folder`). Returns
 * the folders deleted (0 = denied or already gone).
 */
export async function removeFolder(
  args: { folderId: string },
  options?: StoreOptions,
): Promise<number> {
  return await refusalsReadable(
    undefined,
    async () =>
      await queryScalar<number>(
        clientOf(options).rpc("delete_project_folder", { p_folder: args.folderId }),
      ),
  );
}

/** Ids per move request: every id rides the request URL, so a large selection goes in batches. */
const MOVE_BATCH = 100;

/** Moves catalog items (membership row ids) into `folderId` (null = the root). Returns the affected row count. */
export async function moveArtifacts(
  args: { membershipIds: string[]; folderId: string | null },
  options?: StoreOptions,
): Promise<number> {
  const batches: string[][] = [];
  for (let start = 0; start < args.membershipIds.length; start += MOVE_BATCH) {
    batches.push(args.membershipIds.slice(start, start + MOVE_BATCH));
  }
  return await refusalsReadable(undefined, async () => {
    const counts = await Promise.all(
      batches.map(async (ids) => {
        const rows = await queryRows<{ id: string }>(
          clientOf(options)
            .from("project_artifacts")
            .update({ folder_id: args.folderId })
            .in("id", ids)
            .select("id"),
        );
        return rows.length;
      }),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  });
}
