import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/integrations/supabase/provider";
import { errorMessage } from "@/lib/errors";
import { sharedClient } from "@/lib/store/client";
import {
  invite,
  listMembersQueryOptions,
  remove,
  ROLE_LABELS,
  updateRole,
  type InviteableRole,
  type ProjectMemberRow,
  type ProjectRole,
} from "@/lib/store/project-members";
import type { ProjectRow } from "@/lib/store/projects";
import { attachProjectRealtime } from "@/lib/store/realtime";

/**
 * The project members dialog (issue #255; ADR 0017) — the workspace's
 * collaboration surface: every member's row with its role badge, and — for
 * owners — the invite-by-email form (the `project_invite_resolve` definer
 * RPC: 0002 keeps the email column server-side), per-member role changes,
 * and removal. The creator's owner row renders permanently-locked (the DB
 * guard trigger would refuse it; the controls are disabled with that reason,
 * never silent no-ops — the UI-polish rule). Non-owners get the read-only
 * list with a note; viewers read, editors work, owners manage.
 *
 * Live: one project-scoped realtime channel rides the dialog while it is
 * open (`attachProjectRealtime`), invalidating the membership queries so a
 * co-owner's invite appears without a reload.
 */

/** The inviteable roles (owners are born, never invited — ADR 0017). */
const INVITE_ROLES: readonly InviteableRole[] = ["editor", "viewer"];

/** True when the row is the creator's own owner membership (the permanent one). */
function isCreatorOwner(member: ProjectMemberRow, project: ProjectRow): boolean {
  return member.role === "owner" && member.userId === project.createdBy;
}

function RoleBadge({ role }: { role: ProjectRole }) {
  const variant = role === "owner" ? "default" : role === "editor" ? "secondary" : "outline";
  return (
    <Badge variant={variant}>
      <ShieldCheck className="h-3 w-3" />
      {ROLE_LABELS[role]}
    </Badge>
  );
}

/** The member display line: profile name (fallback "Member …id"), the member's email only for self. */
function MemberIdentity({ email, member }: { email: string | null; member: ProjectMemberRow }) {
  const name =
      member.profile.name !== null && member.profile.name !== ""
        ? member.profile.name
        : `Member ${member.userId.slice(0, 8)}`,
    selfEmail = email !== null && email !== "" ? email : null;
  return (
    <div className="flex min-w-0 flex-col">
      <p className="truncate text-sm font-medium">{name}</p>
      <p className="truncate text-xs text-muted-foreground">{selfEmail ?? member.userId}</p>
    </div>
  );
}

/** The owner's invite form: email + role + submit (the store's invite resolves the email server-side). */
function InviteForm({ onInvited, projectId }: { onInvited: () => void; projectId: string }) {
  const [email, setEmail] = useState(""),
    [role, setRole] = useState<InviteableRole>("editor"),
    [inviting, setInviting] = useState(false),
    submit = async (): Promise<void> => {
      if (email.trim() === "") {
        toast.error("Enter the email of the account to invite.");
        return;
      }
      setInviting(true);
      try {
        const member = await invite({ email: email.trim(), projectId, role });
        if (member === null) {
          toast.error("The invite didn't land — you may not manage this project.");
          return;
        }
        toast.success(
          `Invited ${member.profile.name ?? "the new member"} as ${ROLE_LABELS[role]}.`,
        );
        setEmail("");
        onInvited();
      } catch (error) {
        toast.error(errorMessage(error, "The invite failed."));
      } finally {
        setInviting(false);
      }
    };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pg-member-invite-email">
          Invite by email <span className="text-destructive">*</span>
        </Label>
        <Input
          autoComplete="off"
          id="pg-member-invite-email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          placeholder="teammate@example.com"
          type="email"
          value={email}
        />
        <p className="text-xs text-muted-foreground">
          The account must already exist on this instance — invites resolve to signed-up profiles.
        </p>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pg-member-invite-role">Role</Label>
          <Select
            onValueChange={(value) => {
              if (value === "editor" || value === "viewer") {
                setRole(value);
              }
            }}
            value={role}
          >
            <SelectTrigger className="w-36" id="pg-member-invite-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVITE_ROLES.map((inviteRole) => (
                <SelectItem key={inviteRole} value={inviteRole}>
                  {ROLE_LABELS[inviteRole]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button disabled={inviting} type="submit">
          {inviting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="mr-2 h-4 w-4" />
          )}
          {inviting ? "Inviting…" : "Invite"}
        </Button>
      </div>
    </form>
  );
}

/** One member row: identity + role badge + (owners only) the role select and remove controls. */
function MemberRow({
  email,
  member,
  onRemoved,
  project,
  canManage,
}: {
  canManage: boolean;
  email: string | null;
  member: ProjectMemberRow;
  onRemoved: () => void;
  project: ProjectRow;
}) {
  const [busy, setBusy] = useState(false),
    permanent = isCreatorOwner(member, project),
    changeRole = async (role: ProjectRole): Promise<void> => {
      if (role === member.role) {
        return;
      }
      setBusy(true);
      try {
        const affected = await updateRole({ memberId: member.id, role });
        if (affected === 0) {
          toast.error("The role didn't change — you may not manage this project.");
          return;
        }
        toast.success(`Role set to ${ROLE_LABELS[role]}.`);
        onRemoved();
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setBusy(false);
      }
    },
    removeMember = async (): Promise<void> => {
      setBusy(true);
      try {
        const affected = await remove({ memberId: member.id });
        if (affected === 0) {
          toast.error("The member didn't remove — you may not manage this project.");
          return;
        }
        toast.success("Member removed.");
        onRemoved();
      } catch (error) {
        toast.error(errorMessage(error, "Something went wrong."));
      } finally {
        setBusy(false);
      }
    };
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <MemberIdentity email={email} member={member} />
      <div className="ml-auto flex items-center gap-2">
        <RoleBadge role={member.role} />
        {canManage ? (
          <>
            <Select
              disabled={busy || permanent}
              onValueChange={(value) => {
                if (value === "editor" || value === "owner" || value === "viewer") {
                  void changeRole(value);
                }
              }}
              value={member.role}
            >
              <SelectTrigger
                className="w-28"
                title={
                  permanent ? "The project creator's owner membership is permanent." : undefined
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              aria-label={`Remove ${member.profile.name ?? "member"}`}
              disabled={busy || permanent}
              onClick={() => {
                void removeMember();
              }}
              size="sm"
              title={
                permanent
                  ? "The project creator's owner membership is permanent."
                  : "Remove from project"
              }
              variant="ghost"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The members surface (the dialog's body, also the Members section page — issue #271): invite form + member rows with live updates while `isOpen`. */
export function PgProjectMembersPanel({
  isOpen,
  myRole,
  project,
}: {
  isOpen: boolean;
  myRole: ProjectRole;
  project: ProjectRow;
}) {
  const queryClient = useQueryClient(),
    { session } = useSession(),
    membersQuery = useQuery({
      ...listMembersQueryOptions({ projectId: project.id }),
      enabled: isOpen,
    }),
    selfEmail =
      session !== null && session.user.email !== undefined && session.user.email !== null
        ? session.user.email
        : null,
    canManage = myRole === "owner",
    invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["pg:project-members"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
    };
  // One project channel while open (the layer's per-surface granularity):
  // membership changes from co-owners arrive live.
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    return attachProjectRealtime(sharedClient(), project.id, invalidate);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the channel rides the open project only; invalidate is stable per instance.
  }, [isOpen, project.id]);
  const members = membersQuery.data;
  return (
    <>
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Users className="h-4 w-4" />
          Members
        </h2>
        <p className="text-sm text-muted-foreground">
          {canManage
            ? "Invite teammates and manage their access — owners manage, editors work, viewers read."
            : `You have ${ROLE_LABELS[myRole]} access — member management is owner-only.`}
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {canManage ? <InviteForm onInvited={invalidate} projectId={project.id} /> : null}
        {members === undefined ? (
          <div className="flex min-h-20 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : members.length === 0 ? (
          <p className="rounded-lg border px-4 py-3 text-center text-sm text-muted-foreground">
            No membership rows are visible — refresh to re-sync.
          </p>
        ) : (
          members.map((member) => (
            <MemberRow
              canManage={canManage}
              email={session !== null && member.userId === session.user.id ? selfEmail : null}
              key={member.id}
              member={member}
              onRemoved={invalidate}
              project={project}
            />
          ))
        )}
      </div>
    </>
  );
}

/** The members dialog (kept for callers wanting a modal). */
export function PgProjectMembersDialog({
  isOpen,
  myRole,
  onOpenChange,
  project,
}: {
  isOpen: boolean;
  myRole: ProjectRole;
  onOpenChange: (open: boolean) => void;
  project: ProjectRow;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={isOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="sr-only">Members</DialogTitle>
          <DialogDescription className="sr-only">Project members and roles.</DialogDescription>
        </DialogHeader>
        <PgProjectMembersPanel isOpen={isOpen} myRole={myRole} project={project} />
      </DialogContent>
    </Dialog>
  );
}
