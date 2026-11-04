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
import { useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import type { DatasetRow } from "@/lib/store/datasets";

import { publishPgDatasetVersion } from "../lib/pg-publish";

/**
 * The publish dialog for a Postgres dataset (stage 4, #203): freezes the
 * dataset's CURRENT rows as an immutable version through `publish_version`,
 * and — for an import-created draft — flips it into the catalog in the same
 * flow. The publish key is minted by the OPENER when the dialog opens and
 * reused by every submit inside the session, so a double-submit or a retried
 * hung submit re-selects the same frozen version instead of forking a second
 * one (the RPC's ON CONFLICT (publish_key) rule; design §5.4).
 *
 * Honesty rules this dialog follows (ui-polish): a locked dataset answered
 * only by its creator renders the disabled action WITH the reason (never a
 * silently disabled button — the same denial the RPC would raise), the
 * version label is required with an inline warning while empty, and a draft
 * flip that moved zero rows says so instead of toasting success.
 */
export function PgPublishDialog({
  dataset,
  onOpenChange,
  open,
  publishKey,
}: {
  dataset: DatasetRow;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** The idempotency key minted at open time — see the module comment. */
  publishKey: string;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    // The creator gate, inline: importing the datasets feature's
    // edit-policy helper from here would close a datasets → publishing
    // import cycle (ADR 0014) — the rule is two comparisons.
    me = session === null ? undefined : { authId: session.user.id },
    isCreator = me !== undefined && me.authId === dataset.createdBy,
    lockedForViewer = dataset.editPolicy === "locked" && !isCreator,
    isDraft = dataset.lifecycle === "draft",
    [label, setLabel] = useState(""),
    [submitting, setSubmitting] = useState(false),
    labelEmpty = label.trim() === "",
    submit = async (): Promise<void> => {
      if (labelEmpty) {
        toast.error("Give the version a label.");
        return;
      }
      setSubmitting(true);
      try {
        const outcome = await publishPgDatasetVersion({
          datasetId: dataset.id,
          isDraft,
          publishKey,
          versionLabel: label.trim(),
        });
        if (isDraft && !outcome.draftFlipped) {
          toast.error(
            "The version froze, but the draft flip didn't land — you may not have access to publish this dataset. Refresh to check its state.",
          );
        } else {
          toast.success(
            `Froze ${label.trim()} — the dataset's current rows are now an immutable version.`,
          );
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:versions"] });
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        onOpenChange(false);
      } catch (error) {
        // A locked dataset's denial (or any RPC refusal) surfaces verbatim.
        toast.error(errorMessage(error, "The publish failed."));
      } finally {
        setSubmitting(false);
      }
    };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish version</DialogTitle>
          <DialogDescription>
            Freezes the dataset's current rows as an immutable, materialized version — the catalog
            stays append-only: nothing rewrites an earlier version.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {isDraft && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              This dataset is a draft. Publishing also lists it in the catalog — drafts are
              invisible to other users until then.
            </p>
          )}
          {lockedForViewer && (
            <p className="rounded-md border px-3 py-2 text-sm text-destructive">
              This dataset is locked — only its creator can publish versions of it.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pg-publish-label">Version label</Label>
            <Input
              aria-invalid={labelEmpty}
              id="pg-publish-label"
              onChange={(event) => {
                setLabel(event.target.value);
              }}
              placeholder="v1"
              value={label}
            />
            {labelEmpty && (
              <p className="text-xs font-medium text-destructive">
                A version label is required before publishing.
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Retry-safe: this publish carries key{" "}
            <span className="font-mono">{publishKey.slice(0, 8)}…</span> — submitting again with it
            re-uses the same frozen version instead of creating a second one.
          </p>
          <DialogFooter>
            <Button
              disabled={submitting || lockedForViewer}
              title={lockedForViewer ? "Only the dataset's creator can publish it." : undefined}
              type="submit"
            >
              <Rocket className="mr-2 h-4 w-4" />
              {submitting ? "Publishing…" : "Publish version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
