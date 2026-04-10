import React, { useCallback, useRef } from 'react'
import BeadDetailPanel from './BeadDetailPanel'
import CommentThread from './CommentThread'
import UnifiedTimeline from './UnifiedTimeline'
import { AsyncButton } from './AsyncButton'
import type { Bead, FileLock } from '../types/ipc'

/** Locks older than 30 minutes are considered stale. */
const STALE_LOCK_THRESHOLD_MS = 30 * 60_000

export interface BeadCardProps {
  bead: Bead
  projectPath: string
  expanded: boolean
  onToggleExpand: (beadId: string) => void
  commentCount: number
  locks: FileLock[]
  onClaim: (id: string) => Promise<void>
  onClose: (id: string) => Promise<void>
  onReopen: (id: string) => Promise<void>
  onRollback: (id: string) => Promise<void>
  onForceUnlock: (id: string) => Promise<void>
  onChangePriority: (id: string, priority: number) => void
  onStartEdit: (bead: Bead) => void
  /** Drag-and-drop handlers */
  index: number
  isDragging: boolean
  isDropTarget: boolean
  onDragStart: (idx: number) => void
  onDragOver: (e: React.DragEvent, idx: number) => void
  onDragEnd: () => void
}

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

export default function BeadCard({
  bead, projectPath, expanded, onToggleExpand, commentCount, locks,
  onClaim, onClose, onReopen, onRollback, onForceUnlock, onChangePriority, onStartEdit,
  index, isDragging, isDropTarget, onDragStart, onDragOver, onDragEnd,
}: BeadCardProps) {
  const commentRef = useRef<HTMLDivElement>(null)

  const isLocked = locks.length > 0
  const oldestLockAge = isLocked
    ? Date.now() - Math.min(...locks.map(l => new Date(l.reservedAt).getTime()))
    : 0
  const isStale = oldestLockAge > STALE_LOCK_THRESHOLD_MS

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    // Don't toggle if clicking interactive elements
    const target = e.target as HTMLElement
    if (target.closest('select, button, a, input')) return
    onToggleExpand(bead.id)
  }, [bead.id, onToggleExpand])

  const handleHeaderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggleExpand(bead.id)
    }
  }, [bead.id, onToggleExpand])

  const handleCommentBadgeClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    // Expand if collapsed, then scroll to comments
    if (!expanded) onToggleExpand(bead.id)
    requestAnimationFrame(() => {
      commentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }, [bead.id, expanded, onToggleExpand])

  return (
    <div
      className={`bead-card${isDragging ? ' bead-dragging' : ''}${isDropTarget ? ' bead-drop-target' : ''}${expanded ? ' bead-card-expanded' : ''}`}
      draggable
      onDragStart={() => onDragStart(index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDragEnd={onDragEnd}
    >
      {/* Clickable header region */}
      <div className="bead-card-header" onClick={handleHeaderClick} onKeyDown={handleHeaderKeyDown} role="button" tabIndex={0}>
        <span className={`bead-expand-chevron${expanded ? ' bead-expand-chevron-open' : ''}`}>{'\u25B6'}</span>
        <span className={`badge badge-${statusColor(bead.status)}`}>{statusLabel(bead.status)}</span>
        <span className="bead-id">{bead.id}</span>
        <span className="bead-type-tag">{bead.type}</span>
        {isLocked && (
          <span className={`badge ${isStale ? 'badge-danger' : 'badge-warning'}`} title={
            `Locked by ${locks[0].agentId} — ${locks.length} file(s)` +
            (isStale ? ` (stale: ${Math.round(oldestLockAge / 60_000)}m)` : '')
          }>
            {'\uD83D\uDD12'} {isStale ? 'stale lock' : 'locked'}
          </span>
        )}
        {commentCount > 0 && (
          <button
            className="badge badge-idle bead-comment-badge"
            title={`${commentCount} comment(s) — click to view`}
            onClick={handleCommentBadgeClick}
          >
            {'\uD83D\uDCAC'} {commentCount}
          </button>
        )}
        <span className="bead-spacer" />

        <select className={`select select-xs priority-select p${bead.priority}`}
          value={bead.priority}
          onChange={e => onChangePriority(bead.id, Number(e.target.value))}
          onClick={e => e.stopPropagation()}>
          <option value={0}>P0</option>
          <option value={1}>P1</option>
          <option value={2}>P2</option>
          <option value={3}>P3</option>
          <option value={4}>P4</option>
        </select>
      </div>

      <h4 className="bead-title" onClick={handleHeaderClick} style={{ cursor: 'pointer' }}>{bead.title}</h4>
      {bead.description && <p className="bead-desc">{bead.description.slice(0, 200)}</p>}

      {bead.tags?.length > 0 && (
        <div className="bead-meta">
          {bead.tags.map((t: string) => <span key={t} className="tag">{t}</span>)}
        </div>
      )}

      <div className="bead-actions">
        {bead.status === 'ready' && (
          <>
            <AsyncButton className="btn-xs btn-info" onClick={() => onClaim(bead.id)}
              pendingContent="Claiming\u2026">Claim</AsyncButton>
            <AsyncButton className="btn-xs btn-success" onClick={() => onClose(bead.id)}
              pendingContent="Closing\u2026">Close</AsyncButton>
          </>
        )}
        {bead.status === 'claimed' && (
          <>
            <AsyncButton className="btn-xs btn-ghost" onClick={() => onReopen(bead.id)}
              pendingContent="Reopening\u2026">Back to Open</AsyncButton>
            <AsyncButton className="btn-xs btn-success" onClick={() => onClose(bead.id)}
              pendingContent="Closing\u2026">Close</AsyncButton>
          </>
        )}
        {bead.status === 'done' && (
          <>
            <AsyncButton className="btn-xs btn-warning" onClick={() => onReopen(bead.id)}
              pendingContent="Reopening\u2026">Reopen</AsyncButton>
            <AsyncButton className="btn-xs btn-danger" onClick={() => onRollback(bead.id)}
              pendingContent="Rolling back\u2026">Rollback</AsyncButton>
          </>
        )}
        {bead.status === 'failed' && (
          <AsyncButton className="btn-xs btn-warning" onClick={() => onReopen(bead.id)}
            pendingContent="Retrying\u2026">Retry</AsyncButton>
        )}
        {bead.status === 'pending' && (
          <AsyncButton className="btn-xs btn-ghost" onClick={() => onReopen(bead.id)}
            pendingContent="Unblocking\u2026">Unblock</AsyncButton>
        )}

        {isStale && (
          <AsyncButton className="btn-xs btn-danger" onClick={() => onForceUnlock(bead.id)}
            pendingContent="Unlocking\u2026">Force Unlock</AsyncButton>
        )}

        <span className="bead-action-spacer" />
        <button className="btn btn-xs btn-ghost" onClick={() => onStartEdit(bead)} disabled={isLocked}
          title={isLocked ? 'Cannot edit while locked' : undefined}>Edit</button>
        <button className="btn btn-xs btn-ghost" onClick={() => onToggleExpand(bead.id)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        {bead.claimedBy && <span className="tag tag-agent">{bead.claimedBy}</span>}
      </div>

      {/* Expandable detail section — unified timeline merges activity, comments, and lifecycle */}
      {expanded && (
        <div className="bead-card-detail-section" ref={commentRef}>
          <UnifiedTimeline
            bead={bead}
            projectPath={projectPath}
          />
        </div>
      )}
    </div>
  )
}
