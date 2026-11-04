import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, type StoreOptions } from "./client";

/**
 * The profiles store (design doc §8.1; stage-3 catalog, issue #202) — the PG
 * counterpart of today's `api.users.me` / `profileByAuthId` reads, over the
 * `public.profiles` table (DDL §3.1, migration 0002).
 *
 * The projection is the ADR 0009 addendum's PUBLIC one exactly as 0002
 * granted it — `id`/`name`/`image`/`created_at`. There is deliberately NO
 * email here: 0002's column grants keep the column server-side (whole-row
 * select would hand every authenticated reader every user's email), and the
 * signed-in user reads their own email from the auth session instead (the
 * header's `session.user.email`). A display name falls back through the
 * session at the call site, never through this table.
 *
 * `id` IS the auth uid (0002: `id uuid primary key references auth.users`),
 * which is also what `datasets.created_by` / `collections.created_by` stamp —
 * so a profile id doubles as the "by X" attribution key and the
 * `/users/$userId` route param (the pre-migration chip's `me.authId`).
 *
 * NOTE: narrow local interface typed from 0002's DDL + grants, not the
 * generated `database.types.ts` (see `./client`).
 */

/** The publicly readable profile projection (0002's column grant set). */
export interface ProfileRow {
  id: string;
  name: string | null;
  image: string | null;
  createdAt: string;
}

const PROFILE_SELECT = "id,name,image,createdAt:created_at";

/** One profile by id (= auth uid = createdBy stamp = route param), or null when absent (RLS never hides a profile from an authenticated reader). */
export async function get(
  args: { profileId: string },
  options?: StoreOptions,
): Promise<ProfileRow | null> {
  return await queryRow<ProfileRow>(
    clientOf(options).from("profiles").select(PROFILE_SELECT).eq("id", args.profileId).limit(1),
  );
}

export function getQueryOptions(args: { profileId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:profiles", "get", args],
    queryFn: async () => await get(args, options),
  });
}
