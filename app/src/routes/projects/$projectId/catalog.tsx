import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { ProjectCatalog } from "#/features/publishing";

// `folder` = the open catalog folder's id (absent = the catalog root).
const searchSchema = z.object({
  folder: z.string().optional(),
});

/** Catalog section of the project shell (issue #271): the project's file browser. */
export const Route = createFileRoute("/projects/$projectId/catalog")({
  component: ProjectCatalog,
  validateSearch: searchSchema,
});
