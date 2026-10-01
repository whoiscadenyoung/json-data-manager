/**
 * One user-facing message from a thrown error, for toasts and inline error
 * copy (issue #135, defect 10): a `ConvexError`'s human-readable text rides
 * `error.data` — `error.message` is the generic "Server Error" the client
 * renders for it, so a naive `.message` read shows users nothing. Prefers a
 * string `data`, then any `Error`'s message, then the caller's fallback.
 *
 * Every panel used to hand-roll this exact function; import it instead.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}
