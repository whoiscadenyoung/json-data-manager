/** "3 minutes ago" style text for a timestamp; falls back to the date for old runs. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(then).toLocaleDateString();
}

/** Debounce helper input: a stable JSON of a value, for cheap dirty/equality checks. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
