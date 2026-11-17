import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@caden/ui/components/alert-dialog";
import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Folder, FolderOpen, Home } from "lucide-react";
import { useRef, useState } from "react";

import { flattenTree, type TreeFolder } from "../lib/catalog-tree";

/** Name one thing: the same dialog creates and renames folders, and renames maps and apps. */
export function FolderNameDialog({
  busy,
  description,
  fieldLabel = "Folder name",
  initialName,
  onOpenChange,
  onSubmit,
  submitLabel,
  title,
}: {
  busy: boolean;
  description: string;
  /** The visible label of the one field. */
  fieldLabel?: string;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
  submitLabel: string;
  title: string;
}) {
  const [name, setName] = useState(initialName),
    inputRef = useRef<HTMLInputElement>(null),
    trimmed = name.trim();
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="sm:max-w-sm" initialFocus={inputRef}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== "") {
              onSubmit(trimmed);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="catalog-name-field">{fieldLabel}</Label>
            <Input
              id="catalog-name-field"
              maxLength={120}
              ref={inputRef}
              onChange={(event) => {
                setName(event.target.value);
              }}
              value={name}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={busy || trimmed === ""} type="submit">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One destination in the "Move to" list. */
function DestinationRow({
  depth,
  disabledReason,
  icon,
  label,
  onPick,
  picked,
}: {
  depth: number;
  disabledReason: string | undefined;
  icon: "home" | "folder";
  label: string;
  onPick: () => void;
  picked: boolean;
}) {
  return (
    <button
      aria-pressed={picked}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent ${picked ? "bg-primary/10 font-medium text-primary" : ""}`}
      disabled={disabledReason !== undefined}
      onClick={onPick}
      style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
      title={disabledReason}
      type="button"
    >
      {icon === "home" ? (
        <Home className="h-4 w-4 shrink-0" />
      ) : picked ? (
        <FolderOpen className="h-4 w-4 shrink-0" />
      ) : (
        <Folder className="h-4 w-4 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Pick where the selection goes: the catalog root or any folder. Folders in
 * `blocked` (a moved folder and everything under it) cannot be picked.
 */
export function MoveDialog({
  blocked,
  busy,
  currentFolderId,
  folders,
  onMove,
  onOpenChange,
  subject,
}: {
  blocked: ReadonlySet<string>;
  busy: boolean;
  /** Where the selection is now (pre-picked; moving there is a no-op). */
  currentFolderId: string | null;
  folders: readonly TreeFolder[];
  onMove: (folderId: string | null) => void;
  onOpenChange: (open: boolean) => void;
  /** What is moving, e.g. "3 items" or "“Budgets”". */
  subject: string;
}) {
  const [picked, setPicked] = useState<string | null>(currentFolderId),
    tree = flattenTree(folders);
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {subject}</DialogTitle>
          <DialogDescription>
            Folders only organise this project. Moving changes nothing about the data.
          </DialogDescription>
        </DialogHeader>
        <fieldset
          aria-label="Destination"
          className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1"
        >
          <DestinationRow
            depth={0}
            disabledReason={undefined}
            icon="home"
            label="Catalog"
            onPick={() => {
              setPicked(null);
            }}
            picked={picked === null}
          />
          {tree.map(({ depth, folder }) => (
            <DestinationRow
              depth={depth + 1}
              disabledReason={
                blocked.has(folder.id) ? "A folder can't move inside itself." : undefined
              }
              icon="folder"
              key={folder.id}
              label={folder.name}
              onPick={() => {
                setPicked(folder.id);
              }}
              picked={picked === folder.id}
            />
          ))}
        </fieldset>
        <DialogFooter>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={busy || picked === currentFolderId}
            onClick={() => {
              onMove(picked);
            }}
            type="button"
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm deleting a folder; what it holds moves up one level. */
export function DeleteFolderDialog({
  busy,
  folderName,
  onConfirm,
  onOpenChange,
  parentName,
}: {
  busy: boolean;
  folderName: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  /** The folder the contents move up to ("Catalog" for the root). */
  parentName: string;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{folderName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Only the folder is deleted. Everything inside it moves to {parentName} and stays in the
            project.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={onConfirm} variant="destructive">
            Delete folder
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
