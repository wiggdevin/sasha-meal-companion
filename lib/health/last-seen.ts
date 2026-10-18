/** "12 min ago", "3 h ago", "2 d ago" or "never" for a source or a sync time. Its own module so
 *  the health sheet can use it without loading the Body dashboard (UI audit 2026-10-18). */
export function lastSeen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
