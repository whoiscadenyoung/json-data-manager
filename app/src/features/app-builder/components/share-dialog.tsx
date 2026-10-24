import { useMutation } from "convex/react";
import { Check, Copy, Globe, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { errorMessage } from "#/lib/errors";
import { cn } from "#/lib/utils";
import { api } from "#convex/_generated/api";
import type { Sharing } from "#convex/appBuilder/validators";

/** The app's share URL — the viewer route, on whatever origin the app is served from. */
export function shareUrlFor(appId: string): string {
  return `${window.location.origin}/apps/${appId}`;
}

export async function copyShareUrl(appId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareUrlFor(appId));
    toast.success("Link copied");
  } catch {
    toast.error("Couldn't copy — select the link and copy it manually.");
  }
}

const OPTIONS: ReadonlyArray<{
  value: Sharing;
  label: string;
  description: string;
  icon: typeof Lock;
}> = [
  {
    description: "Only you can open this app.",
    icon: Lock,
    label: "Private",
    value: "private",
  },
  {
    description:
      "Anyone signed in to this workspace can open it with the link. They see only the datasets they already have access to.",
    icon: Globe,
    label: "Anyone with the link",
    value: "link",
  },
];

export function ShareDialog({
  appId,
  sharing,
  open,
  onOpenChange,
}: {
  appId: string;
  sharing: Sharing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateDetails = useMutation(api.appBuilder.apps.updateDetails),
    [pending, setPending] = useState<Sharing | undefined>(),
    [copied, setCopied] = useState(false),
    setSharing = async (next: Sharing) => {
      if (next === sharing) {
        return;
      }
      setPending(next);
      try {
        await updateDetails({ appId, sharing: next });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't change sharing."));
      } finally {
        setPending(undefined);
      }
    };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share app</DialogTitle>
          <DialogDescription>
            Choose who can open this app's link. Only you can edit it.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2" disabled={pending !== undefined}>
          <legend className="sr-only">Who can open this app</legend>
          {OPTIONS.map((option) => {
            const Icon = option.icon,
              active = (pending ?? sharing) === option.value;
            return (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/50",
                  active ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                )}
              >
                <input
                  type="radio"
                  name="app-sharing"
                  value={option.value}
                  checked={active}
                  className="sr-only"
                  onChange={() => {
                    void setSharing(option.value);
                  }}
                />
                <Icon
                  className={cn("mt-0.5 size-4", active ? "text-primary" : "text-muted-foreground")}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Link</span>
          <div className="flex gap-2">
            <Input
              readOnly
              value={shareUrlFor(appId)}
              aria-label="Share link"
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void copyShareUrl(appId).then(() => {
                  setCopied(true);
                  return setTimeout(() => {
                    setCopied(false);
                  }, 1500);
                });
              }}
            >
              {copied ? <Check /> : <Copy />}
              Copy
            </Button>
          </div>
          {sharing === "private" && pending === undefined && (
            <p className="text-xs text-muted-foreground">
              The link only works for you while the app is private.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
