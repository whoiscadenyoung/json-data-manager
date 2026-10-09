import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { UserPlus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { UserAvatar } from "#/components/user-avatar";
import { errorMessage } from "#/lib/errors";

import { api } from "../../convex/_generated/api";

type Member = FunctionReturnType<typeof api.projects.members>[number];
type ProjectRole = NonNullable<Member["role"]>;

/** The display label for one role — the badge text everywhere members render. */
export function roleLabel(role: ProjectRole): string {
  if (role === "owner") {
    return "Owner";
  }
  return role === "editor" ? "Editor" : "Viewer";
}

/**
 * The viewer's own role, badged — the project browser's cards and the
 * workspace header both render it, so "what can I do here" is answered on
 * sight (ADR 0011's UI line).
 */
export function ProjectRoleBadge({ role }: { role: ProjectRole }) {
  return <Badge variant={roleBadgeVariant(role)}>{roleLabel(role)}</Badge>;
}

/** The badge variant per role — owners pop, viewers recede. */
function roleBadgeVariant(role: ProjectRole): "default" | "secondary" | "outline" {
  if (role === "owner") {
    return "default";
  }
  return role === "editor" ? "secondary" : "outline";
}

const ROLE_ITEMS: { label: string; value: ProjectRole }[] = [
  { label: "Owner — manages members, can delete the project", value: "owner" },
  { label: "Editor — creates and edits everything in the project", value: "editor" },
  { label: "Viewer — read-only", value: "viewer" },
];

/**
 * The project members dialog (phase 1 of the project-workspace design, ADR
 * 0011): who belongs, at what role — and, for owners, the invite form
 * (by Better Auth user id OR email, the users-mirror lookup) plus per-member
 * role change and removal. The creator's row carries no controls: the server
 * refuses every change to it, so the UI never offers one (a project always
 * has its owner). Member management is owner-only server-side; non-owners
 * get the read-only list, with write controls absent rather than disabled —
 * they never had them.
 */
export function ProjectMembersDialog({
  projectId,
  myRole,
  creatorId,
  open,
  onOpenChange,
}: {
  projectId: string;
  myRole: ProjectRole;
  creatorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isOwner = myRole === "owner",
    members = useQuery({ ...convexQuery(api.projects.members, { projectId }), enabled: open }).data,
    setRole = useMutation(api.projects.setRole),
    removeMember = useMutation(api.projects.removeMember);

  const changeRole = async (userId: string, role: ProjectRole) => {
    try {
      await setRole({ projectId, role, userId });
      toast.success("Role updated.");
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    }
  };

  const remove = async (userId: string) => {
    try {
      await removeMember({ projectId, userId });
      toast.success("Member removed.");
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Members</DialogTitle>
          <DialogDescription>
            {isOwner
              ? "Invite collaborators by user id or email — editors edit, viewers watch."
              : "Who this project is shared with."}
          </DialogDescription>
        </DialogHeader>
        {members === undefined ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex flex-col gap-1 py-2">
            {members.map((member) => (
              <MemberRow
                key={member.userId}
                isCreator={member.userId === creatorId}
                isSelfControls={isOwner && member.userId !== creatorId}
                member={member}
                onRemove={() => {
                  void remove(member.userId);
                }}
                onRoleChange={(role) => {
                  void changeRole(member.userId, role);
                }}
              />
            ))}
          </div>
        )}
        {isOwner && <InviteForm projectId={projectId} />}
      </DialogContent>
    </Dialog>
  );
}

/** One member line: avatar, name (id fallback), role — plus the owner's controls when the row isn't the creator's. */
function MemberRow({
  isCreator,
  isSelfControls,
  member,
  onRemove,
  onRoleChange,
}: {
  isCreator: boolean;
  isSelfControls: boolean;
  member: Member;
  onRemove: () => void;
  onRoleChange: (role: ProjectRole) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <UserAvatar className="h-8 w-8" image={member.image} name={member.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.name !== undefined && member.name !== "" ? member.name : member.userId}
          {isCreator && <span className="ml-2 text-xs text-muted-foreground">(creator)</span>}
        </p>
        {member.email !== undefined && (
          <p className="truncate text-xs text-muted-foreground">{member.email}</p>
        )}
      </div>
      {isSelfControls ? (
        <>
          <Select
            items={ROLE_ITEMS}
            value={member.role}
            onValueChange={(next) => {
              if (next !== null && next !== member.role) {
                onRoleChange(next);
              }
            }}
          >
            <SelectTrigger className="w-40 shrink-0" aria-label={`Role for ${member.userId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            title="Remove from project"
            aria-label={`Remove ${member.userId} from project`}
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <Badge variant={roleBadgeVariant(member.role)}>{roleLabel(member.role)}</Badge>
      )}
    </div>
  );
}

/** The owner's invite form: one identifier field (user id or email) + role picker. Nothing is disabled ahead of submit — a blank identifier is answered with a toast, never a silently dead button (the UI-polish rule). */
function InviteForm({ projectId }: { projectId: string }) {
  const addMember = useMutation(api.projects.addMember),
    [user, setUser] = useState(""),
    [role, setRole] = useState<ProjectRole>("viewer"),
    [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (user.trim() === "") {
      toast.error("Enter a user id or email to invite.");
      return;
    }
    setSubmitting(true);
    try {
      await addMember({ projectId, role, user: user.trim() });
      toast.success("Member added.");
      setUser("");
    } catch (error) {
      toast.error(errorMessage(error, "Something went wrong."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3 border-t pt-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="member-invite">
          Invite by user id or email <span className="text-destructive">*</span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="member-invite"
            value={user}
            onChange={(e) => {
              setUser(e.target.value);
            }}
            placeholder="user id or name@example.com"
            className="flex-1"
          />
          <Select
            items={ROLE_ITEMS}
            value={role}
            onValueChange={(next) => {
              if (next !== null) {
                setRole(next);
              }
            }}
          >
            <SelectTrigger className="w-36 shrink-0" aria-label="Role for the invited member">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={submitting} className="shrink-0">
            <UserPlus className="h-4 w-4 mr-2" />
            {submitting ? "Adding…" : "Add member"}
          </Button>
        </div>
      </div>
    </form>
  );
}
