import { WorkflowManager } from "@convex-dev/workflow";
import { ConvexError, v } from "convex/values";

import { components } from "../_generated/api.js";
import type { Doc } from "../_generated/dataModel.js";
import schema from "../schema.js";

// Durable workflow engine (nested component) that drives batched imports.
export const workflow = new WorkflowManager(components.workflow),
  schemaValidator = schema.tables.schemas.validator.extend({
    _creationTime: v.number(),
    _id: v.id("schemas"),
  }),
  // The client-facing view of a `schemas` doc (issue #131): the stored shape
  // minus its two `_storage` pointers. `mapTileArchiveStorageId` names the
  // installed archive blob (internal to the install/delete flows — an
  // installed archive is provable from `mapTileArchiveBuiltVersion` alone);
  // `sourceFileStorageId` names the retained source-file blob and survives
  // only as the `hasSourceFile` flag, the bytes staying reachable through
  // `getSourceFileUrl`'s URL. Every public query that returns a schema doc
  // projects through `toPublicSchemaView` against this validator, so the
  // criterion "no public query returns a `_storage` id" holds by construction.
  publicSchemaViewValidator = schemaValidator
    .omit("mapTileArchiveStorageId", "sourceFileStorageId")
    .extend({ hasSourceFile: v.boolean() }),
  entryValidator = schema.tables.entries.validator.extend({
    _creationTime: v.number(),
    _id: v.id("entries"),
  }),
  // Host-only attestation that a data write is driven by the host's
  // bound-dataset flows (its sync, tag ingest, unbind, or version-retirement
  // path) rather than by a user. Carried on every data-mutating function and
  // checked by `assertDataWritable`; the value names the flow for diagnostics.
  boundWriteValidator = v.optional(v.string());

/**
 * Component-level read-only enforcement for bound datasets
 * (docs/bound-datasets-design.md §2): a schema marked `source` (a live
 * projection of a connected external source) or `lineage` (a frozen
 * point-in-time version) rejects data writes that don't carry the host's
 * `boundWrite` attestation.
 *
 * The enforcement holds regardless of entry point because the attestation is
 * deliberately absent from every `exposeApi` wrapper's args: Convex arg
 * validators are exact, so a browser client cannot smuggle it through a host
 * wrapper, and component functions have no client-facing path at all. The
 * only callers who can supply it are host functions invoking the component
 * directly — exactly the sync/ingest/retirement flows the writes belong to.
 * It is an attestation, not a secret: the host is trusted code; what is
 * enforced is that user-driven paths cannot reach marked datasets' data.
 */
export function assertDataWritable(
  schemaDoc: Pick<Doc<"schemas">, "lineage" | "source">,
  boundWrite: string | undefined,
): void {
  if (boundWrite !== undefined) {
    return;
  }
  if (schemaDoc.source !== undefined || schemaDoc.lineage !== undefined) {
    throw new ConvexError(
      "This dataset is a read-only projection of a connected external source — " +
        "its data changes only through that source's sync/ingest flow, never by direct edits.",
    );
  }
}
