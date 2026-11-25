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
  dataset: (datasetId: string) => LinkProps;
  entry: (datasetId: string, entryId: string) => LinkProps;
}

/** Link props for the dataset surfaces, project-aware. */
export function useDatasetLinks(): DatasetLinks {
  const projectId = useContext(DatasetProjectContext);
  if (projectId === null) {
    return {
      dataset: (datasetId) => ({ params: { datasetId }, to: "/datasets/$datasetId" }),
      entry: (datasetId, entryId) => ({
        params: { entryId, datasetId },
        to: "/datasets/$datasetId/$entryId",
      }),
      home: { to: "/datasets" },
      projectId,
    };
  }
  return {
    dataset: (datasetId) => ({
      params: { projectId, datasetId },
      to: "/projects/$projectId/datasets/$datasetId",
    }),
    entry: (datasetId, entryId) => ({
      params: { entryId, projectId, datasetId },
      to: "/projects/$projectId/datasets/$datasetId/$entryId",
    }),
    home: { params: { projectId }, to: "/projects/$projectId/catalog" },
    projectId,
  };
}
