/**
 * One user-facing message from a thrown error, for toasts and inline error
 * copy: an `Error`'s message, else the caller's fallback.
 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
