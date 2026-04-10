/**
 * Shared timestamp formatting for consistent display across components.
 */

/** Format a timestamp with month, day, hour, and minute. */
export function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

/** Format a timestamp with month, day, hour, minute, and second. */
export function formatTimePrecise(ts: string): string {
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return ts
  }
}

/** Format a timestamp as a relative age string (e.g. "just now", "5m ago", "2h ago", "3d ago"). */
export function formatRelativeTime(ts: string, now: number = Date.now()): string {
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    const diff = now - d.getTime()
    if (diff < 0) return 'just now'
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
  } catch {
    return ts
  }
}

/** Format an elapsed duration string (e.g. "<1m", "5m", "2h 15m"). */
export function formatElapsed(ts: string, now: number = Date.now()): string {
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ''
    const diff = now - d.getTime()
    if (diff < 0) return '<1m'
    if (diff < 60_000) return '<1m'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
    return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m`
  } catch {
    return ''
  }
}
