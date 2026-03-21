import React, { useMemo } from 'react'

interface KanbanBead {
  id: string
  title: string
  status: string
  type: string
  priority: number
  description?: string
  tags?: string[]
  deps?: string[]
  epicId?: string
  claimedBy?: string
}

interface KanbanBoardProps {
  beads: KanbanBead[]
  onClaimBead?: (id: string) => void
  onCloseBead?: (id: string) => void
  onReopenBead?: (id: string) => void
  onSelectBead?: (id: string) => void
  selectedBeadId?: string | null
}

const COLUMNS = [
  { id: 'ready', label: 'Open', statusMatch: ['ready', 'pending'] },
  { id: 'claimed', label: 'In Progress', statusMatch: ['claimed'] },
  { id: 'done', label: 'Closed', statusMatch: ['done', 'failed'] },
] as const

function statusColor(s: string): string {
  if (s === 'done') return 'success'
  if (s === 'claimed') return 'warning'
  if (s === 'ready') return 'info'
  if (s === 'failed') return 'danger'
  return 'idle'
}

function statusLabel(s: string): string {
  if (s === 'ready') return 'open'
  if (s === 'claimed') return 'in progress'
  if (s === 'done') return 'closed'
  return s
}

/**
 * Build a hierarchy: epics -> tasks -> subtasks.
 * Items without a parent (epicId) are shown at top level.
 */
function buildHierarchy(beads: KanbanBead[]): Map<string, KanbanBead[]> {
  const byId = new Map(beads.map(b => [b.id, b]))
  const children = new Map<string, KanbanBead[]>()

  for (const bead of beads) {
    if (bead.epicId && byId.has(bead.epicId)) {
      const list = children.get(bead.epicId) ?? []
      list.push(bead)
      children.set(bead.epicId, list)
    }
  }

  return children
}

function getRoots(beads: KanbanBead[]): KanbanBead[] {
  const ids = new Set(beads.map(b => b.id))
  return beads.filter(b => !b.epicId || !ids.has(b.epicId))
}

export default function KanbanBoard({
  beads,
  onClaimBead,
  onCloseBead,
  onReopenBead,
  onSelectBead,
  selectedBeadId,
}: KanbanBoardProps) {
  const childrenMap = useMemo(() => buildHierarchy(beads), [beads])
  const roots = useMemo(() => getRoots(beads), [beads])

  const columnData = useMemo(() => {
    return COLUMNS.map(col => ({
      ...col,
      items: roots.filter(b => col.statusMatch.includes(b.status as any)),
    }))
  }, [roots])

  return (
    <div className="kanban-board" data-testid="kanban-board">
      {columnData.map(col => (
        <div key={col.id} className="kanban-column" data-testid="kanban-column">
          <div className="kanban-column-header">
            <span className="kanban-column-title">{col.label}</span>
            <span className="kanban-column-count">{col.items.length}</span>
          </div>
          <div className="kanban-column-body">
            {col.items.length === 0 && (
              <div className="kanban-empty" data-testid="kanban-empty">No beads</div>
            )}
            {col.items.map(bead => (
              <KanbanCard
                key={bead.id}
                bead={bead}
                childrenMap={childrenMap}
                beads={beads}
                selectedBeadId={selectedBeadId}
                onSelectBead={onSelectBead}
                onClaimBead={onClaimBead}
                onCloseBead={onCloseBead}
                onReopenBead={onReopenBead}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function KanbanCard({
  bead,
  childrenMap,
  beads,
  selectedBeadId,
  onSelectBead,
  onClaimBead,
  onCloseBead,
  onReopenBead,
}: {
  bead: KanbanBead
  childrenMap: Map<string, KanbanBead[]>
  beads: KanbanBead[]
  selectedBeadId?: string | null
  onSelectBead?: (id: string) => void
  onClaimBead?: (id: string) => void
  onCloseBead?: (id: string) => void
  onReopenBead?: (id: string) => void
}) {
  const children = childrenMap.get(bead.id) ?? []
  const isSelected = selectedBeadId === bead.id
  const isEpic = bead.type === 'epic' || children.length > 0

  // For epics, recursively get sub-children
  const getSubChildren = (parentId: string) => childrenMap.get(parentId) ?? []

  return (
    <div
      className={`kanban-card${isSelected ? ' kanban-card-selected' : ''}${isEpic ? ' kanban-card-epic' : ''}`}
      data-testid="kanban-card"
      data-status={bead.status}
    >
      <div className="kanban-card-header">
        <span className={`badge badge-${statusColor(bead.status)}`}>{statusLabel(bead.status)}</span>
        <span className="kanban-card-id">{bead.id}</span>
        <span className="kanban-card-type">{bead.type}</span>
      </div>

      <div
        className="kanban-card-title"
        onClick={() => onSelectBead?.(bead.id)}
        data-testid="kanban-card-title"
      >
        {bead.title}
      </div>

      {bead.description && (
        <div className="kanban-card-desc">{bead.description.slice(0, 120)}{bead.description.length > 120 ? '...' : ''}</div>
      )}

      {/* Quick actions */}
      <div className="kanban-card-actions">
        {bead.status === 'ready' && onClaimBead && (
          <button className="btn btn-xs btn-info" onClick={() => onClaimBead(bead.id)}>Claim</button>
        )}
        {bead.status === 'ready' && onCloseBead && (
          <button className="btn btn-xs btn-success" onClick={() => onCloseBead(bead.id)}>Close</button>
        )}
        {bead.status === 'claimed' && onCloseBead && (
          <button className="btn btn-xs btn-success" onClick={() => onCloseBead(bead.id)}>Close</button>
        )}
        {(bead.status === 'done' || bead.status === 'failed') && onReopenBead && (
          <button className="btn btn-xs btn-warning" onClick={() => onReopenBead(bead.id)}>Reopen</button>
        )}
        {bead.claimedBy && <span className="tag tag-agent">{bead.claimedBy}</span>}
      </div>

      {/* Children (tasks inside epic, subtasks inside task) */}
      {children.length > 0 && (
        <div className="kanban-children" data-testid="kanban-children">
          <div className="kanban-children-label">{children.length} sub-item{children.length !== 1 ? 's' : ''}</div>
          {children.map(child => {
            const subChildren = getSubChildren(child.id)
            return (
              <div
                key={child.id}
                className={`kanban-child${selectedBeadId === child.id ? ' kanban-child-selected' : ''}`}
                data-testid="kanban-child"
                data-status={child.status}
              >
                <span className={`kanban-child-status kanban-status-${child.status}`}>
                  {child.status === 'done' ? '\u2713' : child.status === 'failed' ? '\u2717' : child.status === 'claimed' ? '\u25B6' : '\u25CB'}
                </span>
                <span
                  className="kanban-child-title"
                  onClick={() => onSelectBead?.(child.id)}
                  data-testid="kanban-child-title"
                >
                  {child.title}
                </span>
                <span className="kanban-child-id">{child.id}</span>
                {/* Subtask count */}
                {subChildren.length > 0 && (
                  <span className="kanban-subtask-count" data-testid="kanban-subtask-count">
                    {subChildren.filter(s => s.status === 'done').length}/{subChildren.length}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
