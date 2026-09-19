import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNow } from "date-fns";
import {
  Calendar,
  Database,
  FolderTree,
  GitCompareArrows,
  Layers,
  MapPin,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Tag,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "#/components/dashboard/confirm-delete-dialog";
import { VersionCompare } from "#/components/version-compare";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { Separator } from "#/components/ui/separator";
import { Textarea } from "#/components/ui/textarea";
import { fieldCount } from "#/lib/json-schema";
import { isSyncStale } from "#/lib/sync-staleness";
import { api } from "#convex/_generated/api";

type CollectionDoc = FunctionReturnType<typeof api.collections.list>[number];
type GroupDoc = FunctionReturnType<typeof api.groups.list>[number];
type DatasetDoc = FunctionReturnType<typeof api.schemas.list>[number];
type BindingDoc = NonNullable<FunctionReturnType<typeof api.bindings.getBySchema>>;
type VersionDoc = FunctionReturnType<typeof api.tags.listVersions>[number];

const NO_PARENT = "none";

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** The Source row for bound datasets: what it syncs from, how recently, and staleness. */
function SourceRow({ binding, source }: { binding?: BindingDoc; source: { name: string } }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</dt>
      <dd className="flex flex-wrap items-center gap-1.5 text-sm">
        <span>
          Synced from <span className="font-medium">{source.name}</span> — read-only
        </span>
        {binding !== undefined && binding.lastSyncedAt !== undefined && (
          <span className="text-muted-foreground">
            · synced {formatDistanceToNow(new Date(binding.lastSyncedAt), { addSuffix: true })}
          </span>
        )}
        {binding !== undefined && isSyncStale(binding) && (
          <Badge variant="destructive">Out of date</Badge>
        )}
      </dd>
    </div>
  );
}

/** The lineage row for frozen tag versions: which snapshot, when, of what. */
function LineageRow({ lineage }: { lineage: NonNullable<DatasetDoc["lineage"]> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Version
      </dt>
      <dd className="flex flex-wrap items-center gap-1.5 text-sm">
        <Badge variant="outline">
          <Tag />
          {lineage.versionLabel}
        </Badge>
        <span>
          frozen {formatDistanceToNow(new Date(lineage.frozenAt), { addSuffix: true })}
        </span>
        <span className="text-muted-foreground">
          · point-in-time copy of{" "}
          <Link
            to="/datasets/$schemaId"
            params={{ schemaId: lineage.sourceSchemaId }}
            className="font-medium hover:underline"
          >
            its live dataset
          </Link>
        </span>
        {lineage.snapshotRef !== undefined && (
          <span className="font-mono text-xs text-muted-foreground">· {lineage.snapshotRef}</span>
        )}
      </dd>
    </div>
  );
}

/** The dataset's type, field count, feature count and creation date at a glance. */
function DetailsCard({ binding, schema }: { binding?: BindingDoc; schema: DatasetDoc }) {
  const fields = fieldCount(schema.schema),
    navigate = useNavigate(),
    unbind = useMutation(api.bindings.unbind),
    [unbindTarget, setUnbindTarget] = useState<string | undefined>(),
    [isUnbinding, setIsUnbinding] = useState(false),
    handleUnbind = async () => {
      setIsUnbinding(true);
      try {
        await unbind({ schemaId: schema._id });
        toast.success("Unbound — the mirrored dataset and its sync history are gone.");
        void navigate({ to: "/datasets" });
      } catch (error) {
        toast.error(errorMessage(error, "Failed to unbind dataset."));
      } finally {
        setIsUnbinding(false);
      }
    };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>This dataset at a glance</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Type
            </dt>
            <dd>
              {schema.kind === "geospatial" ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge>
                    <MapPin />
                    Geospatial
                  </Badge>
                  {schema.geometryType && <Badge variant="outline">{schema.geometryType}</Badge>}
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
          {schema.kind === "geospatial" && (
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Features
              </dt>
              <dd className="text-sm">{schema.featureCount ?? 0} with geometry</dd>
            </div>
          )}
          {schema.source && <SourceRow binding={binding} source={schema.source} />}
          {schema.lineage !== undefined && <LineageRow lineage={schema.lineage} />}
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Created
            </dt>
            <dd className="flex items-center gap-1 text-sm">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              {new Date(schema._creationTime).toLocaleDateString()}
            </dd>
          </div>
        </dl>
        {binding !== undefined && (
          <>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                No longer want this projection? Unbinding deletes the mirrored dataset and its sync
                history — the source tables stay untouched, and a later sync re-creates it. Frozen
                versions are separate datasets and stay.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-destructive hover:text-destructive"
                onClick={() => {
                  setUnbindTarget(schema.title);
                }}
              >
                <Unplug className="h-3.5 w-3.5" />
                Unbind &amp; delete
              </Button>
            </div>
            <ConfirmDeleteDialog
              confirmLabel="Unbind & delete"
              title={`Unbind from ${binding.source} and delete "${schema.title}"?`}
              entityLabel="bound dataset"
              description="The mirrored dataset and its sync history are deleted. The source data is untouched — syncing again re-creates the projection."
              isPending={isUnbinding}
              name={unbindTarget}
              onCancel={() => {
                setUnbindTarget(undefined);
              }}
              onConfirm={() => {
                setUnbindTarget(undefined);
                void handleUnbind();
              }}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Inline name + description form used for both creating and renaming
 * collections/groups — deliberately a plain form, not a Sheet, so the whole
 * organize flow stays inline on the Overview tab. `extra` renders one more
 * field (e.g. a parent-collection select) above the buttons.
 */
function InlineNameDescriptionForm({
  initialDescription = "",
  initialName = "",
  extra,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialDescription?: string;
  initialName?: string;
  extra?: React.ReactNode;
  submitLabel: string;
  onSubmit: (input: { description: string; name: string }) => Promise<void>;
  onCancel: () => void;
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

/** One searchable inline list of candidates to add — the inline counterpart of DatasetPickerSheet. */
function MembershipPicker({
  emptyLabel,
  candidates,
  onPick,
}: {
  emptyLabel: string;
  candidates: Array<{ description?: string; id: string; label: string; subtitle?: string }>;
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
                {candidate.subtitle && (
                  <p className="truncate text-xs text-muted-foreground">{candidate.subtitle}</p>
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

function SectionActions({
  onPick,
  onTogglePick,
  onToggleCreate,
  pickOpen,
  createOpen,
  pickLabel,
  createLabel,
  pickEmptyLabel,
  candidates,
  createForm,
}: {
  onPick: (id: string) => Promise<void>;
  onTogglePick: () => void;
  onToggleCreate: () => void;
  pickOpen: boolean;
  createOpen: boolean;
  pickLabel: string;
  createLabel: string;
  pickEmptyLabel: string;
  candidates: Array<{ description?: string; id: string; label: string; subtitle?: string }>;
  createForm: React.ReactNode;
}) {
  return (
    <>
      <Separator className="my-4" />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onTogglePick}>
          <Plus className="h-3.5 w-3.5" />
          {pickLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onToggleCreate}>
          {createLabel}
        </Button>
      </div>
      {pickOpen && (
        <div className="mt-3">
          <MembershipPicker emptyLabel={pickEmptyLabel} candidates={candidates} onPick={onPick} />
        </div>
      )}
      {createOpen && <div className="mt-3">{createForm}</div>}
    </>
  );
}

/** Many-to-many collection memberships for this dataset, managed inline. */
function CollectionsSection({ schemaId }: { schemaId: string }) {
  const allCollections = useQuery(api.collections.list),
    memberCollections = useQuery(api.collections.listCollectionsBySchema, { schemaId }),
    addSchemaToCollection = useMutation(api.collections.addSchemaToCollection),
    removeSchemaFromCollection = useMutation(api.collections.removeSchemaFromCollection),
    createCollection = useMutation(api.collections.create),
    updateCollection = useMutation(api.collections.update),
    [pickOpen, setPickOpen] = useState(false),
    [createOpen, setCreateOpen] = useState(false),
    [editingId, setEditingId] = useState<string | undefined>(),
    members = memberCollections ?? [],
    memberIds = new Set(members.map((collection) => collection._id)),
    candidates = (allCollections ?? [])
      .filter((collection) => !memberIds.has(collection._id))
      .map((collection) => ({
        description: collection.description,
        id: collection._id,
        label: collection.name,
      })),
    handleRemove = async (collection: CollectionDoc) => {
      try {
        await removeSchemaFromCollection({ collectionId: collection._id, schemaId });
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
              <li key={collection._id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <Link
                    to="/collections/$collectionId"
                    params={{ collectionId: collection._id }}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium hover:underline">
                        {collection.name}
                      </p>
                      {collection.description && (
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
                        setEditingId(collection._id);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove from ${collection.name}`}
                      onClick={() => {
                        void handleRemove(collection);
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {editingId === collection._id && (
                  <InlineNameDescriptionForm
                    initialDescription={collection.description ?? ""}
                    initialName={collection.name}
                    submitLabel="Save changes"
                    onSubmit={async ({ description, name }) => {
                      try {
                        await updateCollection({
                          collectionId: collection._id,
                          description: description || undefined,
                          name,
                        });
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

        <SectionActions
          pickOpen={pickOpen}
          createOpen={createOpen}
          onTogglePick={() => {
            setPickOpen((open) => !open);
            setCreateOpen(false);
          }}
          onToggleCreate={() => {
            setCreateOpen((open) => !open);
            setPickOpen(false);
          }}
          pickLabel="Add to collection"
          createLabel="New collection"
          pickEmptyLabel={
            candidates.length === 0
              ? "Every collection already includes this dataset."
              : "No collections match your search."
          }
          candidates={candidates}
          onPick={async (id) => {
            try {
              await addSchemaToCollection({ collectionId: id, schemaId });
              toast.success("Added to collection.");
            } catch (error) {
              toast.error(errorMessage(error, "Failed to add to collection."));
            }
          }}
          createForm={
            <InlineNameDescriptionForm
              submitLabel="Create & add"
              onSubmit={async ({ description, name }) => {
                try {
                  const collectionId = await createCollection({
                    description: description || undefined,
                    name,
                  });
                  await addSchemaToCollection({ collectionId, schemaId });
                  toast.success(`Added to "${name}".`);
                  setCreateOpen(false);
                } catch (error) {
                  toast.error(errorMessage(error, "Failed to create collection."));
                }
              }}
              onCancel={setCreateOpen.bind(null, false)}
            />
          }
        />
      </CardContent>
    </Card>
  );
}

/** The dataset's single group (0–1), managed inline — standalone groups included. */
function GroupSection({ schemaId, groupId }: { schemaId: string; groupId?: string }) {
  const allGroups = useQuery(api.groups.list, {}),
    allCollections = useQuery(api.collections.list),
    setSchemaGroup = useMutation(api.collections.setSchemaGroup),
    createGroup = useMutation(api.groups.create),
    updateGroup = useMutation(api.groups.update),
    [pickOpen, setPickOpen] = useState(false),
    [createOpen, setCreateOpen] = useState(false),
    [editing, setEditing] = useState(false),
    [parentId, setParentId] = useState(NO_PARENT),
    groups = allGroups ?? [],
    currentGroup =
      groupId === undefined ? undefined : groups.find((group) => group._id === groupId),
    collectionName = (collectionId: string) => {
      const match = (allCollections ?? []).find((collection) => collection._id === collectionId);
      return match ? match.name : undefined;
    },
    subtitle = (group: GroupDoc) =>
      group.collectionId
        ? `in ${collectionName(group.collectionId) ?? "collection"}`
        : "Standalone",
    candidates = groups
      .filter((group) => group._id !== groupId)
      .map((group) => ({ id: group._id, label: group.name, subtitle: subtitle(group) }));

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
        {currentGroup ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <Link
                to="/groups/$groupId"
                params={{ groupId: currentGroup._id }}
                className="flex min-w-0 items-center gap-2"
              >
                <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium hover:underline">
                    {currentGroup.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{subtitle(currentGroup)}</p>
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
                  onClick={async () => {
                    try {
                      await setSchemaGroup({ groupId: null, schemaId });
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
              <InlineNameDescriptionForm
                initialDescription={currentGroup.description ?? ""}
                initialName={currentGroup.name}
                submitLabel="Save changes"
                onSubmit={async ({ description, name }) => {
                  try {
                    await updateGroup({
                      description: description || undefined,
                      groupId: currentGroup._id,
                      name,
                    });
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
        ) : (
          <p className="text-sm text-muted-foreground">
            No group. A dataset can belong to one group.
          </p>
        )}

        <SectionActions
          pickOpen={pickOpen}
          createOpen={createOpen}
          onTogglePick={() => {
            setPickOpen((open) => !open);
            setCreateOpen(false);
          }}
          onToggleCreate={() => {
            setCreateOpen((open) => !open);
            setPickOpen(false);
          }}
          pickLabel={currentGroup ? "Change group" : "Add to group"}
          createLabel="New group"
          pickEmptyLabel={
            candidates.length === 0
              ? currentGroup
                ? "No other groups exist."
                : "No groups exist yet."
              : "No groups match your search."
          }
          candidates={candidates}
          onPick={async (id) => {
            try {
              await setSchemaGroup({ groupId: id, schemaId });
              const picked = groups.find((group) => group._id === id),
                name = picked ? picked.name : "group";
              toast.success(currentGroup ? `Moved to "${name}".` : `Added to "${name}".`);
            } catch (error) {
              toast.error(errorMessage(error, "Failed to set group."));
            }
          }}
          createForm={
            <InlineNameDescriptionForm
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
                      {(allCollections ?? []).map((collection) => (
                        <SelectItem key={collection._id} value={collection._id}>
                          {collection.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
              onSubmit={async ({ description, name }) => {
                try {
                  const groupId = await createGroup({
                    collectionId: parentId === NO_PARENT ? undefined : parentId,
                    description: description || undefined,
                    name,
                  });
                  await setSchemaGroup({ groupId, schemaId });
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
        />
      </CardContent>
    </Card>
  );
}

/**
 * Frozen snapshot versions of a bound live dataset, newest first — the tag
 * ingest's mirror of the foreign app's tag graph. Each version is a normal
 * read-only dataset: its own rows, its own map, pinned in time. Retention
 * (keep-N, pin exemption) and the pairwise compare view live here too.
 */
function VersionsCard({ sourceSchemaId }: { sourceSchemaId: string }) {
  const versions = useQuery(api.tags.listVersions, { sourceSchemaId }),
    retention = useQuery(api.tags.retentionSettings, { sourceSchemaId }),
    setKeepVersions = useMutation(api.tags.setKeepVersions),
    [keepInput, setKeepInput] = useState<string>(),
    [compareOpen, setCompareOpen] = useState(false),
    handleKeepSave = () => {
      const keep = Number(keepInput);
      if (!Number.isInteger(keep) || keep < 1) {
        toast.error("Keep must be a positive whole number.");
        return;
      }
      setKeepVersions({ keep, sourceSchemaId })
        .then(() => {
          toast.success(`Keeping the newest ${keep} unpinned versions.`);
        })
        .catch((error: unknown) => {
          toast.error(errorMessage(error, "Failed to set retention."));
        });
    };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="h-5 w-5" />
          Versions ({versions === undefined ? "…" : versions.length})
        </CardTitle>
        <CardDescription>
          Frozen snapshots ingested from the connected source — each one is a read-only,
          point-in-time copy with its own map layer. Unpinned versions beyond the keep count
          retire automatically at the next ingest.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {retention !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Keep newest</span>
            <Input
              className="h-8 w-20"
              inputMode="numeric"
              value={keepInput ?? String(retention.keepVersions)}
              onChange={(event) => {
                setKeepInput(event.target.value);
              }}
            />
            <span className="text-muted-foreground">unpinned versions</span>
            <Button
              size="sm"
              variant="outline"
              disabled={keepInput === undefined || keepInput === String(retention.keepVersions)}
              onClick={handleKeepSave}
            >
              Save
            </Button>
          </div>
        )}
        {versions !== undefined && versions.length > 1 && (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCompareOpen((open) => !open);
              }}
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              {compareOpen ? "Hide compare" : "Compare versions"}
            </Button>
            {compareOpen && (
              <div className="mt-2">
                <VersionCompare
                  versions={versions.map((version) => ({
                    label:
                      version.lineage === undefined
                        ? "?"
                        : version.lineage.versionLabel,
                    schemaId: version.schemaId,
                    title: version.title,
                  }))}
                />
              </div>
            )}
          </div>
        )}
        {versions === undefined ? null : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet — take a snapshot of the source data and ingest it from the dashboard's
            Snapshots card.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {versions.map((version) => (
              <VersionRow key={version.schemaId} version={version} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function VersionRow({ version }: { version: VersionDoc }) {
  const retire = useMutation(api.tags.retireVersion),
    setPinned = useMutation(api.tags.setVersionPinned),
    retention = useQuery(api.tags.retentionSettings, {
      sourceSchemaId:
        version.lineage === undefined ? version.schemaId : version.lineage.sourceSchemaId,
    }),
    [retireTarget, setRetireTarget] = useState<string | undefined>(),
    [isRetiring, setIsRetiring] = useState(false),
    label = version.lineage === undefined ? undefined : version.lineage.versionLabel,
    ref = version.lineage === undefined ? undefined : version.lineage.snapshotRef,
    isPinned =
      ref !== undefined &&
      retention !== undefined &&
      retention.pinnedRefs !== undefined &&
      retention.pinnedRefs.includes(ref),
    handleRetire = async () => {
      setIsRetiring(true);
      try {
        await retire({ schemaId: version.schemaId });
        toast.success(`Retired "${version.title}".`);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to retire version."));
      } finally {
        setIsRetiring(false);
      }
    },
    handlePinToggle = () => {
      if (ref === undefined) {
        return;
      }
      setPinned({ pinned: !isPinned, schemaId: version.schemaId })
        .then(() => {
          toast.success(isPinned ? "Unpinned — retention may retire it." : "Pinned — never auto-retired.");
        })
        .catch((error: unknown) => {
          toast.error(errorMessage(error, "Failed to update pin."));
        });
    };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <Link
        to="/datasets/$schemaId"
        params={{ schemaId: version.schemaId }}
        className="flex min-w-0 items-center gap-2"
      >
        <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium hover:underline">{version.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {version.entryCount ?? version.featureCount ?? 0} entries · frozen{" "}
            {formatDistanceToNow(new Date(version._creationTime), { addSuffix: true })}
          </p>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-0.5">
        {label !== undefined && (
          <Badge variant="outline">
            <Tag />
            {label}
          </Badge>
        )}
        {isPinned && (
          <Badge variant="secondary">
            <Pin />
            Pinned
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={isPinned ? `Unpin ${version.title}` : `Pin ${version.title}`}
          disabled={ref === undefined}
          onClick={handlePinToggle}
        >
          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Retire ${version.title}`}
          onClick={() => {
            setRetireTarget(version.title);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ConfirmDeleteDialog
        confirmLabel="Retire version"
        title={`Retire "${version.title}"?`}
        entityLabel="frozen version"
        description="Retiring deletes this frozen copy — its rows, geometries, and map archive. The snapshot itself stays, so the version can be re-frozen from the dashboard."
        isPending={isRetiring}
        name={retireTarget}
        onCancel={() => {
          setRetireTarget(undefined);
        }}
        onConfirm={() => {
          setRetireTarget(undefined);
          void handleRetire();
        }}
      />
    </li>
  );
}

/** The Overview tab's content: dataset details plus inline collection/group management. */
export function DatasetOverview({
  binding,
  schema,
  schemaId,
}: {
  binding?: BindingDoc;
  schema: DatasetDoc;
  schemaId: string;
}) {
  return (
    <div className="space-y-6">
      <DetailsCard binding={binding} schema={schema} />
      {binding !== undefined && <VersionsCard sourceSchemaId={schemaId} />}
      <CollectionsSection schemaId={schemaId} />
      <GroupSection schemaId={schemaId} groupId={schema.groupId} />
    </div>
  );
}
