import type { LinkProps } from "@tanstack/react-router";
import { createContext, useContext } from "react";

/**
 * The project the dataset surfaces render inside (issue #271): the project
 * shell wraps the dataset and entry pages in this provider so every link they
 * emit stays inside `/projects/$projectId/…` instead of jumping to the global
 * `/datasets/…` routes. `null` (no provider) = the standalone/public pages.
 */
export const DatasetProjectContext = createContext<string | null>(null);

export interface DatasetLinks {
  /** The enclosing project, or null on the standalone pages. */
  projectId: string | null;
  /** Where "back to the list" goes: the project catalog, or the global explorer. */
  home: LinkProps;
  dataset: (schemaId: string) => LinkProps;
  entry: (schemaId: string, entryId: string) => LinkProps;
}

/** Link props for the dataset surfaces, project-aware. */
export function useDatasetLinks(): DatasetLinks {
  const projectId = useContext(DatasetProjectContext);
  if (projectId === null) {
    return {
      dataset: (schemaId) => ({ params: { schemaId }, to: "/datasets/$schemaId" }),
      entry: (schemaId, entryId) => ({
        params: { entryId, schemaId },
        to: "/datasets/$schemaId/$entryId",
      }),
      home: { to: "/datasets" },
      projectId,
    };
  }
  return {
    dataset: (schemaId) => ({
      params: { projectId, schemaId },
      to: "/projects/$projectId/datasets/$schemaId",
    }),
    entry: (schemaId, entryId) => ({
      params: { entryId, projectId, schemaId },
      to: "/projects/$projectId/datasets/$schemaId/$entryId",
    }),
    home: { params: { projectId }, to: "/projects/$projectId/catalog" },
    projectId,
  };
}
