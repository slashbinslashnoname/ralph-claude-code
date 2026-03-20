export type SortField = 'deps' | 'priority' | 'title' | 'status' | 'type' | 'date'
export type SortDirection = 'asc' | 'desc'

export const STATUS_ORDER: Record<string, number> = {
  ready: 0,
  claimed: 1,
  pending: 2,
  failed: 3,
  done: 4,
}

export const SORT_OPTIONS: { id: SortField; label: string }[] = [
  { id: 'deps', label: 'Deps' },
  { id: 'priority', label: 'Priority' },
  { id: 'date', label: 'Date' },
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'type', label: 'Type' },
]

/** Count unresolved blockers: explicit deps + open children */
function unresolvedBlockers(bead: any, doneIds: Set<string>, openChildCount: Map<string, number>): number {
  const deps = Array.isArray(bead.deps) ? bead.deps : []
  const unresolvedDeps = deps.filter((d: string) => !doneIds.has(d)).length
  return unresolvedDeps + (openChildCount.get(bead.id) ?? 0)
}

export function sortBeads(
  beads: any[],
  sortBy: SortField,
  sortDir: SortDirection
): any[] {
  // Pre-compute for deps sorting
  const doneIds = new Set(beads.filter(b => b.status === 'done').map(b => b.id))
  const openChildCount = new Map<string, number>()
  for (const b of beads) {
    if (b.epicId && b.status !== 'done') {
      openChildCount.set(b.epicId, (openChildCount.get(b.epicId) ?? 0) + 1)
    }
  }

  return [...beads].sort((a, b) => {
    let cmp = 0
    switch (sortBy) {
      case 'deps':
        cmp = unresolvedBlockers(a, doneIds, openChildCount) - unresolvedBlockers(b, doneIds, openChildCount)
        if (cmp === 0) cmp = (a.priority ?? 4) - (b.priority ?? 4)
        break
      case 'date':
        cmp = (a.completedAt ?? a.claimedAt ?? '').localeCompare(b.completedAt ?? b.claimedAt ?? '')
        break
      case 'priority':
        cmp = (a.priority ?? 4) - (b.priority ?? 4)
        break
      case 'title':
        cmp = (a.title ?? '').localeCompare(b.title ?? '')
        break
      case 'status':
        cmp = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
        break
      case 'type':
        cmp = (a.type ?? '').localeCompare(b.type ?? '')
        break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })
}
