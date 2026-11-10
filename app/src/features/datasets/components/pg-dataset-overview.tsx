import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
import { Separator } from "@caden/ui/components/separator";
import { Textarea } from "@caden/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Calendar,
  Database,
  FolderKanban,
  FolderTree,
  Layers,
  LayoutDashboard,
  MapPin,
  Pencil,
  PencilOff,
  Plus,
  Search,
  User,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PgConsumersCard, PgVersionsCard } from "#/features/versions";
import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import * as appsStore from "@/lib/store/apps";
import * as collectionsStore from "@/lib/store/collections";
import type { CollectionRow } from "@/lib/store/collections";
import type { DatasetRow } from "@/lib/store/datasets";
import * as datasetsStore from "@/lib/store/datasets";
import * as groupsStore from "@/lib/store/groups";
import * as profilesStore from "@/lib/store/profiles";
import * as projectsStore from "@/lib/store/projects";

import { isLockedForViewer } from "../lib/edit-policy";

/**
 * The Overview tab of the Postgres dataset page — the Convex
 * `DatasetOverview`'s PG edition: the details card (type, fields, features,
 * created, created by, editing), inline collection membership management,
 * and the single-group management, all over `#/lib/store/{collections,
 * groups,profiles}`.
 *
 * The description flow's THREE enforcement layers (ui-polish: the title is
 * the only required field, the description is optional): (1) this form — the
 * empty-title submit explains itself with an inline warning + toast, the
 * Save button is never silently disabled; (2) the datasets store's
 * `create`/schema-`update` assert (title non-empty); (3) the
 * `datasets.title` NOT NULL constraint. On a locked dataset the membership
 * controls stay visible but disabled with the reason (issue #124 parity).
 */

const NO_PARENT = "none";

/** The Details card's Created-by row — a real profile links to the PG profile page; a vanished account falls back to the raw id, unlinked. */
function CreatedByRow({ authId }: { authId: string }) {
  const query = useQuery(profilesStore.getQueryOptions({ profileId: authId })),
    profile = query.data,
    label = profile === null ? authId : profile === undefined ? "…" : (profile.name ?? authId);
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Created by
      </dt>
      <dd className="flex items-center gap-1 text-sm">
        <User className="h-3.5 w-3.5 text-muted-foreground" />
        {profile === undefined || profile === null ? (
          label
        ) : (
          <Link
            to="/users/$userId"
            params={{ userId: profile.id }}
            className="hover:underline"
            title="View profile"
          >
            {label}
          </Link>
        )}
      </dd>
    </div>
  );
}

/** The Editing row a locked dataset shows (issue #124 parity). Renders nothing while the default ("open") holds. */
function EditingRow({ editPolicy }: { editPolicy: "open" | "locked" }) {
  if (editPolicy !== "locked") {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Editing</dt>
      <dd className="flex items-center gap-1 text-sm">
        <PencilOff className="h-3.5 w-3.5 text-muted-foreground" />
        Locked — creator only
      </dd>
    </div>
  );
}

/**
 * Inline metadata edit (title + description). The required/optional split is
 * visible from every tab's entry point: the title field carries an explicit
 * "required" warning while empty, the description is labeled optional.
 */
function MetadataEditForm({ dataset, onDone }: { dataset: DatasetRow; onDone: () => void }) {
  const queryClient = useQueryClient(),
    [title, setTitle] = useState(dataset.title),
    [description, setDescription] = useState(dataset.description ?? ""),
    [isSubmitting, setIsSubmitting] = useState(false),
    titleEmpty = title.trim() === "",
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      // Layer 1 of the title enforcement: an empty submit explains itself —
      // never a silently disabled Save.
      if (titleEmpty) {
        toast.error("Give the dataset a title.");
        return;
      }
      setIsSubmitting(true);
      try {
        await datasetsStore.update({
          datasetId: dataset.id,
          description: description.trim(),
          title: title.trim(),
        });
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        toast.success("Dataset updated.");
        onDone();
      } catch (error) {
        toast.error(errorMessage(error, "Failed to update the dataset."));
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="mt-4 flex flex-col gap-3 rounded-md border bg-muted/30 p-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pg-dataset-title">Title</Label>
        <Input
          id="pg-dataset-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          placeholder="Dataset title"
          aria-invalid={titleEmpty}
        />
        {titleEmpty && (
          <p className="text-xs font-medium text-destructive">
            A title is required before this can be saved.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pg-dataset-description">Description (optional)</Label>
        <Textarea
          id="pg-dataset-description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
          placeholder="What this dataset holds"
          rows={2}
        />
      </div>
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** The dataset's facts at a glance, with the inline metadata edit behind a pencil button. */
function PgDetailsCard({ dataset }: { dataset: DatasetRow }) {
  const [editing, setEditing] = useState(false),
    fields = dataset.properties.length;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Details</CardTitle>
          <CardDescription>This dataset at a glance</CardDescription>
        </div>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit details
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Type
            </dt>
            <dd>
              {dataset.isGeospatial ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge>
                    <MapPin />
                    Geospatial
                  </Badge>
                  {dataset.geometryType !== null && (
                    <Badge variant="outline">{dataset.geometryType}</Badge>
                  )}
                </span>
              ) : (
                <Badge variant="secondary">
                  <Database />
                  Regular
                </Badge>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Fields
            </dt>
            <dd className="text-sm">
              {fields} {fields === 1 ? "field" : "fields"}
            </dd>
          </div>
          {dataset.isGeospatial && (
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Features
              </dt>
              <dd className="text-sm">{dataset.featureCount} with geometry</dd>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Created
            </dt>
            <dd className="flex items-center gap-1 text-sm">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              {new Date(dataset.createdAt).toLocaleDateString()}
            </dd>
          </div>
          <CreatedByRow authId={dataset.createdBy} />
          <EditingRow editPolicy={dataset.editPolicy} />
        </dl>
        {editing && (
          <MetadataEditForm
            dataset={dataset}
            onDone={() => {
              setEditing(false);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** One searchable inline list of candidates to add — the MembershipPicker's PG edition. */
function PgMembershipPicker({
  candidates,
  emptyLabel,
  onPick,
}: {
  candidates: Array<{ description: string | null; id: string; label: string }>;
  emptyLabel: string;
  onPick: (id: string) => Promise<void>;
}) {
  const [search, setSearch] = useState(""),
    [pendingId, setPendingId] = useState<string | undefined>(),
    normalized = search.trim().toLowerCase(),
    visible = normalized
      ? candidates.filter((candidate) => candidate.label.toLowerCase().includes(normalized))
      : candidates,
    handlePick = async (id: string) => {
      setPendingId(id);
      try {
        await onPick(id);
      } finally {
        setPendingId(undefined);
      }
    };

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          placeholder="Search…"
          className="h-8 pl-7 text-sm"
        />
      </div>
      {visible.length === 0 ? (
        <p className="py-2 text-center text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
          {visible.map((candidate) => (
            <li
              key={candidate.id}
              className="flex items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{candidate.label}</p>
                {candidate.description !== null && (
                  <p className="truncate text-xs text-muted-foreground">{candidate.description}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={pendingId !== undefined}
                onClick={() => {
                  void handlePick(candidate.id);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {pendingId === candidate.id ? "Adding…" : "Add"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shared toggle-row for the Overview sections' pick/create affordances. */
function PgSectionActions({
  candidates,
  createForm,
  createLabel,
  createOpen,
  lockedHint,
  onPick,
  onToggleCreate,
  onTogglePick,
  pickEmptyLabel,
  pickLabel,
  pickOpen,
}: {
  candidates: Array<{ description: string | null; id: string; label: string }>;
  createForm: React.ReactNode;
  createLabel: string;
  createOpen: boolean;
  /** Set on a locked dataset (issue #124 parity): the membership buttons stay visible but disabled, carrying the reason. */
  lockedHint?: string;
  onPick: (id: string) => Promise<void>;
  onToggleCreate: () => void;
  onTogglePick: () => void;
  pickEmptyLabel: string;
  pickLabel: string;
  pickOpen: boolean;
}) {
  return (
    <>
      <Separator className="my-4" />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={lockedHint !== undefined}
          title={lockedHint}
          onClick={onTogglePick}
        >
          <Plus className="h-3.5 w-3.5" />
          {pickLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={lockedHint !== undefined}
          title={lockedHint}
          onClick={onToggleCreate}
        >
          {createLabel}
        </Button>
      </div>
      {pickOpen && (
        <div className="mt-3">
          <PgMembershipPicker candidates={candidates} emptyLabel={pickEmptyLabel} onPick={onPick} />
        </div>
      )}
      {createOpen && <div className="mt-3">{createForm}</div>}
    </>
  );
}

/** Inline name + description form for the Overview's create-and-add flows (collections and groups). */
function PgInlineNameDescriptionForm({
  extra,
  initialDescription = "",
  initialName = "",
  submitLabel,
  onCancel,
  onSubmit,
}: {
  extra?: React.ReactNode;
  initialDescription?: string;
  initialName?: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: { description: string; name: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initialName),
    [description, setDescription] = useState(initialDescription),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!name.trim()) {
        toast.error("Give it a name.");
        return;
      }
      setIsSubmitting(true);
      try {
        await onSubmit({ description: description.trim(), name: name.trim() });
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label>Name</Label>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="Name"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Description (optional)</Label>
        <Textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
          placeholder="What it's for"
          rows={2}
        />
      </div>
      {extra}
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Many-to-many collection memberships for this dataset, managed inline (`listCollectionsBySchema` + add/remove/create parity, over the collections store). */
function PgCollectionsSection({
  dataset,
  lockedHint,
}: {
  dataset: DatasetRow;
  lockedHint?: string;
}) {
  const queryClient = useQueryClient(),
    allCollectionsQuery = useQuery(collectionsStore.listQueryOptions()),
    memberQuery = useQuery(
      collectionsStore.listCollectionsByDatasetQueryOptions({ datasetId: dataset.id }),
    ),
    [pickOpen, setPickOpen] = useState(false),
    [createOpen, setCreateOpen] = useState(false),
    [editingId, setEditingId] = useState<string | undefined>(),
    members = memberQuery.data ?? [],
    allCollections = allCollectionsQuery.data ?? [],
    memberIds = new Set(members.map((member) => member.id)),
    candidates = allCollections
      .filter((collection) => !memberIds.has(collection.id))
      .map((collection) => ({
        description: collection.description,
        id: collection.id,
        label: collection.name,
      })),
    invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
    },
    handleRemove = async (collection: CollectionRow) => {
      try {
        await collectionsStore.removeFromCollection({
          collectionId: collection.id,
          datasetId: dataset.id,
        });
        invalidate();
        toast.success(`Removed from "${collection.name}".`);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to remove from collection."));
      }
    };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderTree className="h-5 w-5" />
          Collections ({members.length})
        </CardTitle>
        <CardDescription>A dataset can live in any number of collections</CardDescription>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not in any collection.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map((collection) => (
              <li key={collection.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Link
                    to="/collections/$collectionId"
                    params={{ collectionId: collection.id }}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium hover:underline">
                        {collection.name}
                      </p>
                      {collection.description !== null && (
                        <p className="truncate text-xs text-muted-foreground">
                          {collection.description}
                        </p>
                      )}
                    </div>
                  </Link>
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${collection.name}`}
                      onClick={() => {
                        setEditingId(collection.id);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove from ${collection.name}`}
                      disabled={lockedHint !== undefined}
                      title={lockedHint}
                      onClick={() => {
                        void handleRemove(collection);
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {editingId === collection.id && (
                  <PgInlineNameDescriptionForm
                    initialDescription={collection.description ?? ""}
                    initialName={collection.name}
                    submitLabel="Save changes"
                    onSubmit={async ({ description, name }) => {
                      try {
                        await collectionsStore.update({
                          collectionId: collection.id,
                          description,
                          name,
                        });
                        invalidate();
                        toast.success("Collection updated.");
                        setEditingId(undefined);
                      } catch (error) {
                        toast.error(errorMessage(error, "Failed to update collection."));
                      }
                    }}
                    onCancel={() => {
                      setEditingId(undefined);
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        <PgSectionActions
          candidates={candidates}
          createLabel="New collection"
          createOpen={createOpen}
          createForm={
            <PgInlineNameDescriptionForm
              submitLabel="Create & add"
              onSubmit={async ({ description, name }) => {
                try {
                  const collectionId = await collectionsStore.create({ description, name });
                  await collectionsStore.addToCollection({
                    collectionId,
                    datasetId: dataset.id,
                  });
                  invalidate();
                  toast.success(`Added to "${name}".`);
                  setCreateOpen(false);
                } catch (error) {
                  toast.error(errorMessage(error, "Failed to create collection."));
                }
              }}
              onCancel={() => {
                setCreateOpen(false);
              }}
            />
          }
          lockedHint={lockedHint}
          pickEmptyLabel={
            candidates.length === 0
              ? "Every collection already includes this dataset."
              : "No collections match your search."
          }
          pickLabel="Add to collection"
          pickOpen={pickOpen}
          onToggleCreate={() => {
            setCreateOpen((open) => !open);
            setPickOpen(false);
          }}
          onTogglePick={() => {
            setPickOpen((open) => !open);
            setCreateOpen(false);
          }}
          onPick={async (id) => {
            try {
              await collectionsStore.addToCollection({ collectionId: id, datasetId: dataset.id });
              invalidate();
              toast.success("Added to collection.");
            } catch (error) {
              toast.error(errorMessage(error, "Failed to add to collection."));
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

/** The dataset's single group (0–1), managed inline — standalone groups included, over the groups store. */
// oxlint-disable-next-line eslint/complexity -- the page reads both stores' catalog rows and composes the store seams; ad hoc splitting risks these render paths (the same #82 phase-2 note the sibling Convex pages carry).
function PgGroupSection({ dataset, lockedHint }: { dataset: DatasetRow; lockedHint?: string }) {
  const queryClient = useQueryClient(),
    allGroupsQuery = useQuery(groupsStore.listQueryOptions()),
    allCollectionsQuery = useQuery(collectionsStore.listQueryOptions()),
    currentGroupQuery = useQuery({
      ...groupsStore.getQueryOptions({ groupId: dataset.groupId ?? "" }),
      enabled: dataset.groupId !== null,
    }),
    [pickOpen, setPickOpen] = useState(false),
    [createOpen, setCreateOpen] = useState(false),
    [editing, setEditing] = useState(false),
    [parentId, setParentId] = useState(NO_PARENT),
    groups = allGroupsQuery.data ?? [],
    allCollections = allCollectionsQuery.data ?? [],
    currentGroup = currentGroupQuery.data,
    activeGroupId = dataset.groupId,
    candidates = groups
      .filter((group) => group.id !== activeGroupId)
      .map((group) => ({
        description: group.description,
        id: group.id,
        label: group.name,
      })),
    invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    },
    groupName = (id: string): string => {
      const match = groups.find((group) => group.id === id);
      return match === undefined ? "group" : match.name;
    },
    collectionName = (id: string): string => {
      const match = allCollections.find((collection) => collection.id === id);
      return match === undefined ? "collection" : match.name;
    };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5" />
          Group
        </CardTitle>
        <CardDescription>
          One group per dataset — grouped datasets appear under their group in the datasets browser
        </CardDescription>
      </CardHeader>
      <CardContent>
        {currentGroup === undefined || currentGroup === null ? (
          <p className="text-sm text-muted-foreground">
            No group. A dataset can belong to one group.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <Link
                to="/groups/$groupId"
                params={{ groupId: currentGroup.id }}
                className="flex min-w-0 items-center gap-2"
              >
                <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium hover:underline">
                    {currentGroup.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {currentGroup.collectionId === null
                      ? "Standalone"
                      : `In ${collectionName(currentGroup.collectionId)}`}
                  </p>
                </div>
              </Link>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${currentGroup.name}`}
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove from ${currentGroup.name}`}
                  disabled={lockedHint !== undefined}
                  title={lockedHint}
                  onClick={async () => {
                    try {
                      await groupsStore.setDatasetGroup({ datasetId: dataset.id, groupId: null });
                      invalidate();
                      toast.success(`Removed from "${currentGroup.name}".`);
                    } catch (error) {
                      toast.error(errorMessage(error, "Failed to remove from group."));
                    }
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {editing && (
              <PgInlineNameDescriptionForm
                initialDescription={currentGroup.description ?? ""}
                initialName={currentGroup.name}
                submitLabel="Save changes"
                onSubmit={async ({ description, name }) => {
                  try {
                    await groupsStore.update({
                      description,
                      groupId: currentGroup.id,
                      name,
                    });
                    invalidate();
                    toast.success("Group updated.");
                    setEditing(false);
                  } catch (error) {
                    toast.error(errorMessage(error, "Failed to update group."));
                  }
                }}
                onCancel={() => {
                  setEditing(false);
                }}
              />
            )}
          </div>
        )}

        <PgSectionActions
          candidates={candidates}
          createLabel="New group"
          createOpen={createOpen}
          createForm={
            <PgInlineNameDescriptionForm
              submitLabel="Create & add"
              extra={
                <div className="flex flex-col gap-1.5">
                  <Label>Parent collection (optional)</Label>
                  <Select
                    value={parentId}
                    onValueChange={(value) => {
                      setParentId(value ?? NO_PARENT);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PARENT}>Standalone (no collection)</SelectItem>
                      {allCollections.map((collection) => (
                        <SelectItem key={collection.id} value={collection.id}>
                          {collection.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
              onSubmit={async ({ description, name }) => {
                try {
                  const groupId = await groupsStore.create({
                    collectionId: parentId === NO_PARENT ? undefined : parentId,
                    description,
                    name,
                  });
                  await groupsStore.setDatasetGroup({ datasetId: dataset.id, groupId });
                  invalidate();
                  toast.success(`Added to "${name}".`);
                  setCreateOpen(false);
                  setParentId(NO_PARENT);
                } catch (error) {
                  toast.error(errorMessage(error, "Failed to create group."));
                }
              }}
              onCancel={() => {
                setCreateOpen(false);
                setParentId(NO_PARENT);
              }}
            />
          }
          lockedHint={lockedHint}
          pickEmptyLabel={
            candidates.length === 0
              ? activeGroupId === null
                ? "No groups exist yet."
                : "No other groups exist."
              : "No groups match your search."
          }
          pickLabel={activeGroupId === null ? "Add to group" : "Change group"}
          pickOpen={pickOpen}
          onToggleCreate={() => {
            setCreateOpen((open) => !open);
            setPickOpen(false);
          }}
          onTogglePick={() => {
            setPickOpen((open) => !open);
            setCreateOpen(false);
          }}
          onPick={async (id) => {
            try {
              await groupsStore.setDatasetGroup({ datasetId: dataset.id, groupId: id });
              invalidate();
              toast.success(
                activeGroupId === null
                  ? `Added to "${groupName(id)}".`
                  : `Moved to "${groupName(id)}".`,
              );
            } catch (error) {
              toast.error(errorMessage(error, "Failed to set group."));
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

/** The Overview tab's content for a Postgres dataset: details (with the inline metadata edit) plus inline collection/group management. `lockedHint` is set when the viewer may not write the dataset and explains every disabled control. */
/**
 * The dataset's "used in" back-references (issue #262): the viewer's member
 * projects holding it (owned or linked — the D1 memberships) and the live
 * apps whose shared data sources include it. RLS scopes both reads, so the
 * card answers honestly for the viewer: foreign projects and invisible apps
 * never appear. The version consumers (pinned references) have their own
 * card; this one is the project/app surface.
 */
function PgUsedInCard({ datasetId }: { datasetId: string }) {
  const memberships = useQuery(projectsStore.listVisibleArtifactMembershipsQueryOptions()),
    apps = useQuery(appsStore.listVisibleQueryOptions()),
    inProjects = (memberships.data ?? [])
      .filter(
        (membership) =>
          membership.artifactId === datasetId && membership.artifactKind === "dataset",
      )
      .map((membership) => membership.project),
    usingApps = (apps.data ?? []).filter((app) => appsStore.appUsesDataset(app, datasetId)),
    empty = inProjects.length === 0 && usingApps.length === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Used in</CardTitle>
        <CardDescription>Projects holding this dataset, and apps reading from it</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {empty && (
          <p className="text-sm text-muted-foreground">
            Not referenced by any of your projects or apps yet — use the browser's "Add to project"
            affordance to reference it.
          </p>
        )}
        {inProjects.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Projects
            </span>
            {inProjects.map((project) => (
              <Badge key={project.id} variant="outline">
                <FolderKanban />
                <Link
                  className="hover:underline"
                  params={{ projectId: project.id }}
                  to="/projects/$projectId"
                >
                  {project.title}
                </Link>
              </Badge>
            ))}
          </div>
        )}
        {usingApps.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Apps
            </span>
            {usingApps.map((app) => (
              <Badge key={app.id} variant="outline">
                <LayoutDashboard />
                <Link className="hover:underline" params={{ appId: app.id }} to="/apps/$appId">
                  {app.title}
                </Link>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PgDatasetOverview({
  dataset,
  lockedHint,
}: {
  dataset: DatasetRow;
  lockedHint?: string;
}) {
  const { session } = useSession(),
    me = session === null ? undefined : { authId: session.user.id },
    effectiveLockedHint =
      lockedHint ??
      (isLockedForViewer(dataset, me)
        ? "Locked datasets can only be edited by their creator."
        : undefined);
  return (
    <div className="space-y-6">
      <PgDetailsCard dataset={dataset} />
      {/* Stage 4 (#203): the version chain, tags, and consumers — the Convex
          overview's version cards, PG edition. Mounted here (not on the
          versions feature's own page) because the Convex overview is where
          the version cards live. */}
      <PgVersionsCard datasetId={dataset.id} datasetTitle={dataset.title} />
      <PgConsumersCard datasetId={dataset.id} />
      <PgUsedInCard datasetId={dataset.id} />
      <PgCollectionsSection dataset={dataset} lockedHint={effectiveLockedHint} />
      <PgGroupSection dataset={dataset} lockedHint={effectiveLockedHint} />
    </div>
  );
}
