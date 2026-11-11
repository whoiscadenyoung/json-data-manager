import { buildFrozenTileArchive, outputOfViewDefinition } from "@/features/maps";
import * as appVersionsStore from "@/lib/store/app-versions";
import type {
  AppDatasetPin,
  AppMapSnapshot,
  AppSnapshotLayerVersion,
} from "@/lib/store/app-versions";
import * as appsStore from "@/lib/store/apps";
import { clientOf, queryRow, type StoreOptions } from "@/lib/store/client";
import * as datasetsStore from "@/lib/store/datasets";
import * as layersStore from "@/lib/store/layers";
import * as mapsStore from "@/lib/store/maps";

/**
 * The app publish walk (issue #259 — the project-centric train's phase 5;
 * ADR 0021): freezes one app's config snapshot into an append-only
 * `app_versions` row, the per-artifact freeze D6 gives apps (the bundle
 * press stays the convenience closure over per-artifact publishes).
 *
 * The snapshot is self-contained by construction — the published viewer
 * renders ONLY from it plus the immutable `version_entries`:
 *   - pages jsonb verbatim (map widgets keep their `mapId`);
 *   - `datasetPins`: every referenced dataset's head version + frozen
 *     meta + the version's frozen tile archive stamp when one was worth
 *     building (the #261 tile leg — built from the version's own rows,
 *     uploaded under the frozen path convention 0024's anon policy reads);
 *     a dataset with no chain yet pins honest nulls (its widgets
 *     render "unavailable" until it publishes — the closure preflight in
 *     [project 6] will make widening explicit);
 *   - `mapSnapshots` + a flattened `layerVersions` list: per referenced
 *     map, placements freeze as pointers into the version list. An owned
 *     layer with NO version yet publishes first (the publishLayer
 *     group-closure precedent — a draft can't be snapshotted); an owned
 *     layer WITH a version freezes its existing head (republishing the
 *     layer moves the next snapshot, exactly like a dataset pin moves on
 *     its own publish); a linked placement freezes the pinned version
 *     as-is. Groups freeze recursively through `frozenChildren`.
 *
 * Returns the new version row, or null when the app is invisible; throws
 * the honest error when a leg of the closure can't freeze (an invisible
 * map, an unreadable layer version, a denied child publish).
 */

/** The publish outcome: the frozen row plus what the dialog tells the user. */
export interface PgAppPublishResult {
  version: appVersionsStore.AppVersionRow;
  /** Datasets whose widgets will render "unavailable" in the published app (no version at freeze). */
  unpinnedDatasetTitles: string[];
  /** Datasets whose frozen tile build failed (#261 — the pin stamps null and the widget renders rows); the dialog notes them. */
  frozenTileNotes: string[];
}

/** The store row's `LayerVersionRow.dataset` shape (layers.ts publishes it). */
interface FrozenDatasetRef {
  sourceMemberId: string;
  pinnedVersionId: string | null;
  pinnedRef: string | null;
}

/** The store row's `LayerVersionRow.frozenChildren` shape. */
interface FrozenChild {
  childKind: "owned" | "linked";
  childLayerId: string;
  versionId: string | null;
}

/** The membership lookup the dataset resolution needs (one read per unique membership). */
async function membershipArtifactId(
  membershipId: string,
  options?: StoreOptions,
): Promise<string | null> {
  const membership = await queryRow<{ artifactId: string }>(
    clientOf(options)
      .from("project_artifacts")
      .select("artifactId:artifact_id")
      .eq("id", membershipId)
      .limit(1),
  );
  return membership === null ? null : membership.artifactId;
}

/**
 * Runs one of the store modules' `queryOptions` factories imperatively (the
 * publish walk is client code, not a React surface — the same fact
 * pg-bundle-publish records for the press).
 */
async function runStoreRead<T>(
  queryFn: ((context: never) => T | Promise<T>) | undefined,
): Promise<T> {
  if (queryFn === undefined) {
    throw new Error("The store read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing.
  return await queryFn({} as never);
}

/** The next version label from the chain head (the headOf convention: vN+1, v1 on a fresh chain). */
async function nextVersionLabel(args: { appId: string }, options?: StoreOptions): Promise<string> {
  const head = await appVersionsStore.head(args, options);
  if (head === null) {
    return "v1";
  }
  const match = /^v(\d+)$/.exec(head.versionLabel);
  return match === null ? "v1" : `v${Number(match[1]) + 1}`;
}

// The walk joins five stores and walks a recursive closure — the branches
// are the artifact kinds' contracts (data/group/linked), stated once, read
// top to bottom. The loops await in dependency order (child freezes feed the
// flattened list), the bundle-press shape — the no-await-in-loop rule is
// suspended for this file, scoped to the walk.
/* oxlint-disable eslint/no-await-in-loop -- the freeze legs run in child order; each await feeds the next. */
export async function publishApp(
  args: { appId: string },
  options?: StoreOptions,
): Promise<PgAppPublishResult | null> {
  const app = await appsStore.get(args, options);
  if (app === null) {
    return null;
  }

  // ---- the referenced maps: placements freeze through their layer versions ----
  const mapIds = [
    ...new Set(
      app.pages
        .flatMap((page) => page.widgets)
        .filter((widget) => widget.kind === "map")
        .map((widget) => widget["mapId"])
        .filter((mapId): mapId is string => typeof mapId === "string" && mapId !== ""),
    ),
  ];
  const layerVersionsById = new Map<string, AppSnapshotLayerVersion>();
  const mapSnapshots: AppMapSnapshot[] = [];

  /** Resolves one layer_versions row into the flattened list (recursing through group children); returns its snapshot entry. */
  // The freeze legs are the contract, stated once (the publishLayer posture).
  // oxlint-disable-next-line eslint/complexity -- the closure walk is the contract.
  const freezeVersion = async (versionId: string): Promise<AppSnapshotLayerVersion> => {
    const known = layerVersionsById.get(versionId);
    if (known !== undefined) {
      return known;
    }
    const version = await layersStore.getVersion({ versionId }, options);
    if (version === null) {
      throw new Error(
        "A referenced layer version isn't visible — publish from a project where every referenced layer is visible to you.",
      );
    }
    const definition = (version.definition ?? {}) as Record<string, unknown>;
    let dataset: AppSnapshotLayerVersion["dataset"] = null;
    if (version.dataset !== null) {
      const frozen = version.dataset as FrozenDatasetRef;
      const datasetId = await membershipArtifactId(frozen.sourceMemberId, options);
      if (datasetId === null) {
        throw new Error(
          "A referenced layer's data membership isn't visible — publish from a project where every referenced layer is visible to you.",
        );
      }
      // The view's output labels ride the snapshot (#330): anonymous popups
      // cannot read `view_definition` (authenticated-only grant), so the
      // publish stamps the labels next to the pin it was read for. One
      // datasets read per data layer, publish-time only.
      // oxlint-disable-next-line eslint/no-await-in-loop -- the freeze closure resolves layer by layer; each stamp feeds the entry below.
      const pinnedDataset = await queryRow<{ definition: unknown; kind: string }>(
        clientOf(options).from("datasets").select("definition,kind").eq("id", datasetId).limit(1),
      );
      dataset = {
        datasetId,
        output:
          pinnedDataset !== null && pinnedDataset.kind === "view"
            ? outputOfViewDefinition(pinnedDataset.definition)
            : undefined,
        ref: frozen.pinnedRef,
        versionId: frozen.pinnedVersionId ?? "",
      };
    }
    let frozenChildren: AppSnapshotLayerVersion["frozenChildren"] = null;
    if (version.frozenChildren !== null) {
      const children = version.frozenChildren as FrozenChild[];
      frozenChildren = [];
      for (const child of children) {
        if (child.versionId === null) {
          throw new Error(
            "A referenced group holds an unpublished child — publish the group first.",
          );
        }
        // oxlint-disable-next-line no-await-in-loop -- the closure freezes in child order; each entry feeds the flattened list.
        await freezeVersion(child.versionId);
        frozenChildren.push({
          childKind: child.childKind,
          childLayerId: child.childLayerId,
          versionId: child.versionId,
        });
      }
    }
    const entry: AppSnapshotLayerVersion = {
      dataset,
      definition,
      frozenChildren,
      // Version rows carry no kind — the writer guarantees exactly one of
      // dataset/frozenChildren is set, and that IS the kind.
      kind: version.dataset === null ? "group" : "data",
      layerId: version.layerId,
      versionId: version.id,
    };
    layerVersionsById.set(versionId, entry);
    return entry;
  };

  for (const mapId of mapIds) {
    const map = await mapsStore.get({ mapId }, options);
    if (map === null) {
      throw new Error(
        "One of the app's maps isn't visible — it may live in a project you're not a member of.",
      );
    }
    const placements = await mapsStore.listPlacements({ mapId }, options);
    const frozenPlacements: AppMapSnapshot["placements"] = [];
    for (const placement of placements) {
      const membership = await queryRow<{ artifactId: string; role: string }>(
        clientOf(options)
          .from("project_artifacts")
          .select("artifactId:artifact_id,role")
          .eq("id", placement.layerMemberId)
          .limit(1),
      );
      if (membership === null) {
        throw new Error(
          "One of the map's placements isn't a readable layer membership — publish from the map's own project.",
        );
      }
      let versionId: string;
      if (membership.role === "owned") {
        const layer = await layersStore.get({ layerId: membership.artifactId }, options);
        if (layer === null) {
          throw new Error(
            "One of the map's layers isn't visible — publish from the map's own project.",
          );
        }
        const headVersion = await layersStore.headVersion({ layerId: layer.id }, options);
        // A layer with no version yet publishes first (a draft can't be
        // snapshotted); a published layer freezes its existing head — the
        // next layer publish moves the NEXT app snapshot, like a dataset pin.
        versionId =
          headVersion === null
            ? ((await layersStore.publishLayer({ layerId: layer.id }, options)) ?? "")
            : headVersion.id;
        if (versionId === "") {
          throw new Error(`The layer "${layer.name}" didn't publish — you may not have access.`);
        }
      } else {
        // A LINKED placement's artifactId IS the frozen layer_versions id
        // (the link-or-clone contract: a read-only pin at an existing
        // freeze — the map editor resolves placements the same way). The
        // snapshot reuses that version verbatim; nothing re-freezes.
        const version = await layersStore.getVersion({ versionId: membership.artifactId }, options);
        if (version === null) {
          throw new Error(
            "One of the map's linked layers isn't visible — its frozen version is gone or unreadable.",
          );
        }
        versionId = version.id;
      }
      // oxlint-disable-next-line no-await-in-loop -- placements freeze in draw order; each entry feeds the flattened list.
      await freezeVersion(versionId);
      frozenPlacements.push({
        order: placement.order,
        versionId,
        visible: placement.visible,
      });
    }
    mapSnapshots.push({
      basemap: map.basemap,
      mapId: map.id,
      name: map.name,
      placements: frozenPlacements,
      viewport: map.viewport,
    });
  }

  // ---- the referenced datasets: head pins (no chain yet = honest nulls) ----
  const datasetPins: AppDatasetPin[] = [];
  const unpinnedDatasetTitles: string[] = [];
  const frozenTileNotes: string[] = [];
  for (const datasetId of app.datasetIds) {
    const dataset = await runStoreRead(
      datasetsStore.getQueryOptions({ datasetId }, options).queryFn,
    );
    if (dataset === null) {
      unpinnedDatasetTitles.push(datasetId);
      datasetPins.push({
        bbox: null,
        datasetId,
        geometryType: null,
        isGeospatial: false,
        jsonSchema: null,
        ref: null,
        title: null,
        versionId: null,
      });
      continue;
    }
    const head = await queryRow<{ id: string; ref: string }>(
      clientOf(options)
        .from("dataset_versions")
        .select("id,ref")
        .eq("dataset_id", dataset.id)
        .order("created_at", { ascending: false })
        .limit(1),
    );
    if (head === null) {
      unpinnedDatasetTitles.push(dataset.title);
    }
    // The frozen tile leg (#261): build the pinned version's archive from its
    // own immutable rows so a published map can serve tiles (incl. to anon,
    // migration 0024's policy) without touching the live rows. Degrades to
    // null — rows render — on a below-threshold skip or any failure; a tile
    // leg never fails the publish.
    let frozenArchive: appVersionsStore.FrozenDatasetArchive | null = null;
    if (
      head !== null &&
      dataset.isGeospatial &&
      dataset.geometryType !== null &&
      dataset.geometryType !== undefined
    ) {
      try {
        frozenArchive = await buildFrozenTileArchive({ datasetId: dataset.id, versionId: head.id });
      } catch (error) {
        frozenTileNotes.push(
          `${dataset.title}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    datasetPins.push({
      archive: frozenArchive,
      bbox: dataset.bbox,
      datasetId: dataset.id,
      geometryType: dataset.geometryType,
      isGeospatial: dataset.isGeospatial,
      jsonSchema: dataset.jsonSchema,
      ref: head === null ? null : head.ref,
      title: dataset.title,
      versionId: head === null ? null : head.id,
    });
  }

  const version = await appVersionsStore.insert(
    {
      appId: app.id,
      definition: {
        datasetPins,
        description: app.description,
        layerVersions: [...layerVersionsById.values()],
        mapSnapshots,
        pages: app.pages,
        title: app.title,
      },
      versionLabel: await nextVersionLabel(args, options),
    },
    options,
  );
  if (version === null) {
    throw new Error("The publish didn't land — you may not have access.");
  }
  return { frozenTileNotes, unpinnedDatasetTitles, version };
}
/* oxlint-enable eslint/no-await-in-loop */
