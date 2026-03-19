export type SortField = 'priority' | 'title' | 'status' | 'type'
export type SortDirection = 'asc' | 'desc'

export const STATUS_ORDER: Record<string, number> = {
  ready: 0,
  claimed: 1,
  pending: 2,
  failed: 3,
  done: 4,
}

export const SORT_OPTIONS: { id: SortField; label: string }[] = [
  { id: 'priority', label: 'Priority' },
  { id: 'title', label: 'Title' },
  { id: 'status', label: 'Status' },
  { id: 'type', label: 'Type' },
]

export function sortBeads(
  beads: any[],
  sortBy: SortField,
  sortDir: SortDirection
): any[] {
  return [...beads].sort((a, b) => {
    let cmp = 0
    switch (sortBy) {
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
