import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sortBeads, SORT_OPTIONS, type SortField, type SortDirection } from '../utils/sortBeads'
import BeadCard from '../components/BeadCard'
import { AsyncButton } from '../components/AsyncButton'
import { useToast } from '../components/Toast'
import type { Bead, BeadType, FileLock, PlanQueueItem } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

type BeadFilter = 'open' | 'in_progress' | 'closed'

const TABS: { id: BeadFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'closed', label: 'Closed' },
]

export default function BeadsPage({ projectPath }: Props) {
  const { showToast } = useToast()
  const [beads, setBeads] = useState<Bead[]>([])
  const [filter, setFilter] = useState<BeadFilter>('open')
  const [bdAvailable, setBdAvailable] = useState(true)
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newType, setNewType] = useState<BeadType>('task')
  const [newPriority, setNewPriority] = useState(2)
  const [newDeps, setNewDeps] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<SortField>('deps')
  const [sortDir, setSortDir] = useState<SortDirection>('asc')
  const [editing, setEditing] = useState<Bead | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [planPrompt, setPlanPrompt] = useState('')
  const [isPlanning, setIsPlanning] = useState(false)
  const [planPhase, setPlanPhase] = useState('')
  const [planRequest, setPlanRequest] = useState('')
  const [planQueue, setPlanQueue] = useState<PlanQueueItem[]>([])
  const [expandedBead, setExpandedBead] = useState<string | null>(null)
  const [locksByBead, setLocksByBead] = useState<Map<string, FileLock[]>>(new Map())
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map())

  const refreshLocks = useCallback(async () => {
    const r = await sb.locks.list(projectPath)
    if (r.ok) {
      const map = new Map<string, FileLock[]>()
      for (const lock of r.locks) {
        const list = map.get(lock.beadId) ?? []
        list.push(lock)
        map.set(lock.beadId, list)
      }
      setLocksByBead(map)
    }
  }, [projectPath])

  const refresh = useCallback(async () => {
    setLoading(true)
    const check = await sb.beads.check(projectPath)
    setBdAvailable(check.available)
    if (check.available) {
      const r = await sb.beads.list(projectPath, filter)
      if (r.ok) {
        setBeads(r.tasks)
        // Fetch comment counts in parallel
        const counts = new Map<string, number>()
        await Promise.all(r.tasks.map(async (bead: { id: string }) => {
          try {
            const comments = await sb.beads.comments(projectPath, bead.id)
            const count = Array.isArray(comments) ? comments.length : 0
            if (count > 0) counts.set(bead.id, count)
          } catch { /* ignore */ }
        }))
        setCommentCounts(counts)
      }
    }
    setLoading(false)
  }, [projectPath, filter])

  useEffect(() => { refresh(); refreshLocks() }, [refresh, refreshLocks])

  // Plan inject listeners
  useEffect(() => {
    sb.swarm.status(projectPath).then(s => {
      setIsPlanning(s.planning ?? false)
      setPlanRequest(s.planRequest ?? '')
    })
    sb.swarm.queue(projectPath).then(setPlanQueue)
    const unsubs = [
      sb.swarm.onPlanPhase((_p: string, phase: string, request?: string) => {
        setPlanPhase(phase)
        setPlanRequest(request ?? '')
        setIsPlanning(phase !== '' && phase !== 'done')
        if (phase === 'done') { setPlanRequest(''); setTimeout(refresh, 1000) }
      }),
      sb.swarm.onPlanQueue((_p: string, q: PlanQueueItem[]) => setPlanQueue(q)),
      sb.swarm.onStopped(() => { setIsPlanning(false); setPlanRequest(''); refresh() }),
    ]
    return () => unsubs.forEach(u => u())
  }, [projectPath])

  const injectPlan = useCallback(async () => {
    if (!planPrompt.trim()) return
    await sb.swarm.inject(projectPath, planPrompt)
    setPlanPrompt('')
  }, [projectPath, planPrompt])

  const createBead = useCallback(async () => {
    if (!newTitle.trim()) return
    const r = await sb.beads.create(projectPath, {
      title: newTitle, type: newType, priority: newPriority,
      description: newDesc || undefined,
      deps: newDeps.length > 0 ? newDeps : undefined,
    })
    if (!r.ok) throw new Error(r.error ?? 'Failed to create bead')
    setNewTitle(''); setNewDesc(''); setNewDeps([]); setShowCreate(false)
    refresh()
  }, [projectPath, newTitle, newDesc, newType, newPriority, newDeps, refresh])

  const claimBead = useCallback(async (id: string) => {
    const r = await sb.beads.update(projectPath, id, { claim: true })
    if (!r.ok) throw new Error(r.error ?? `Failed to claim ${id}`)
    refresh()
  }, [projectPath, refresh])

  const closeBead = useCallback(async (id: string) => {
    const r = await sb.beads.close(projectPath, id, 'Done')
    if (!r.ok) throw new Error(r.error ?? `Failed to close ${id}`)
    refresh()
  }, [projectPath, refresh])

  const reopenBead = useCallback(async (id: string) => {
    const r = await sb.beads.reopen(projectPath, id, 'Back to open')
    if (!r.ok) throw new Error(r.error ?? `Failed to reopen ${id}`)
    refresh()
  }, [projectPath, refresh])

  const rollbackBead = useCallback(async (id: string) => {
    const r = await sb.beads.rollback(projectPath, id)
    if (!r.ok) throw new Error(r.error ?? `Failed to rollback ${id}`)
    refresh()
  }, [projectPath, refresh])

  const changePriority = useCallback(async (id: string, priority: number) => {
    try {
      await sb.beads.update(projectPath, id, { priority })
      refresh()
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Failed to update priority`, { variant: 'error' })
    }
  }, [projectPath, refresh, showToast])

  const forceUnlock = useCallback(async (beadId: string) => {
    const r = await sb.locks.forceUnlock(projectPath, beadId)
    if (!r.ok) throw new Error(r.error ?? `Failed to unlock ${beadId}`)
    refreshLocks()
  }, [projectPath, refreshLocks])

  const startEdit = useCallback((bead: Bead) => {
    setEditing(bead)
    setEditTitle(bead.title)
    setEditDesc(bead.description ?? '')
  }, [])

  const saveEdit = useCallback(async () => {
    if (!editing) return
    const updates: Record<string, string> = {}
    if (editTitle !== editing.title) updates.title = editTitle
    if (editDesc !== (editing.description ?? '')) updates.description = editDesc
    if (Object.keys(updates).length > 0) {
      const r = await sb.beads.update(projectPath, editing.id, updates)
      if (!r.ok) throw new Error(r.error ?? 'Failed to save changes')
    }
    setEditing(null)
    refresh()
  }, [projectPath, editing, editTitle, editDesc, refresh])

  const cancelEdit = useCallback(() => setEditing(null), [])

  const toggleDetail = useCallback((beadId: string) => {
    setExpandedBead(prev => prev === beadId ? null : beadId)
  }, [])

  const toggleSort = useCallback((field: SortField) => {
    if (sortBy === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(field)
      setSortDir('asc')
    }
  }, [sortBy])

  const sortedBeads = useMemo(() => sortBeads(beads, sortBy, sortDir), [beads, sortBy, sortDir])

  // ── Drag-and-drop reordering ──────────────────────────────────────────
  const dragItem = useRef<number | null>(null)
  const dragOverItem = useRef<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)

  const handleDragStart = useCallback((idx: number) => {
    dragItem.current = idx
    setDragIdx(idx)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    dragOverItem.current = idx
    setDropIdx(idx)
  }, [])

  const handleDragEnd = useCallback(async () => {
    const from = dragItem.current
    const to = dragOverItem.current
    dragItem.current = null
    dragOverItem.current = null
    setDragIdx(null)
    setDropIdx(null)

    if (from === null || to === null || from === to) return

    // Reorder the list and assign priorities based on new position
    const reordered = [...sortedBeads]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)

    // Assign priorities 0..N based on new order
    const updates: Promise<{ ok: boolean }>[] = []
    for (let i = 0; i < reordered.length; i++) {
      const bead = reordered[i]
      const newPriority = Math.min(i, 4)
      if (bead.priority !== newPriority) {
        updates.push(sb.beads.update(projectPath, bead.id, { priority: newPriority }))
      }
    }
    if (updates.length > 0) {
      try {
        await Promise.all(updates)
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Failed to reorder beads', { variant: 'error' })
      }
      refresh()
    }
  }, [sortedBeads, projectPath, refresh, showToast])

  if (!bdAvailable) {
    return (
      <div className="page">
        <header className="page-header"><h2>Beads</h2></header>
        <div className="empty-state">
          <span className="empty-icon">{'\u29BE'}</span>
          <h3>bd CLI not found</h3>
          <p>Install beads-rust to manage tasks:</p>
          <code>cargo install beads-rust</code>
          <p className="mt-2">Then run <code>bd init</code> in your project.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <h2>Beads</h2>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
            + Create Bead
          </button>
          <button className="btn btn-ghost" onClick={refresh} disabled={loading}>
            {'\u27F3'} Refresh
          </button>
        </div>
      </header>

      {/* Plan inject */}
      <div className="card card-loop1">
        <div className="card-header-bar">
          <h3>Plan & Encode Beads</h3>
          {isPlanning && <span className="badge badge-warning animate-pulse">Planning: {planPhase}</span>}
        </div>
        <div className="prompt-area">
          <textarea
            className="textarea textarea-prompt"
            placeholder="Describe what you want to build... Claude will analyze the codebase, create a plan, and encode it as beads."
            rows={2}
            value={planPrompt}
            onChange={e => setPlanPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) injectPlan() }}
          />
          <AsyncButton className="btn-primary" onClick={injectPlan} disabled={!planPrompt.trim()}
            pendingContent="Injecting\u2026">
            {isPlanning ? `+ Queue Plan (${planQueue.length + 1})` : 'Inject Plan'}
          </AsyncButton>
        </div>
        {(isPlanning || planQueue.length > 0) && (
          <div className="queue-list">
            {isPlanning && (
              <div className="queue-item queue-item-active">
                <span className="badge badge-warning animate-pulse">{planPhase || 'planning'}</span>
                <span title={planRequest}>{planRequest ? (planRequest.length > 80 ? planRequest.slice(0, 80) + '...' : planRequest) : 'Running...'}</span>
              </div>
            )}
            {planQueue.map((q, i) => (
              <div key={q.id} className="queue-item">
                <span className="badge badge-idle">#{i + 1}</span>
                <span>{q.request.slice(0, 80)}{q.request.length > 80 ? '...' : ''}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => sb.swarm.queueRemove(projectPath, q.id)}>
                  {'\u2715'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status tabs */}
      <div className="bead-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`tab ${filter === tab.id ? 'active' : ''}`}
            onClick={() => {
              setFilter(tab.id)
              if (tab.id === 'closed') { setSortBy('date'); setSortDir('desc') }
              else if (filter === 'closed') { setSortBy('deps'); setSortDir('asc') }
            }}
          >
            {tab.label}
            {filter === tab.id && beads.length > 0 && (
              <span className="tab-count">{beads.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card card-create animate-slide-down">
          <h3>New Bead</h3>
          <div className="form-grid">
            <input className="input" placeholder="Title" value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createBead()} autoFocus />
            <div className="form-row">
              <select className="select" value={newType} onChange={e => setNewType(e.target.value as BeadType)}>
                <option value="epic">Epic</option>
                <option value="task">Task</option>
                <option value="subtask">Subtask</option>
                <option value="feature">Feature</option>
                <option value="bug">Bug</option>
              </select>
              <select className="select" value={newPriority} onChange={e => setNewPriority(Number(e.target.value))}>
                <option value={0}>P0 Critical</option>
                <option value={1}>P1 High</option>
                <option value={2}>P2 Medium</option>
                <option value={3}>P3 Low</option>
                <option value={4}>P4 Lowest</option>
              </select>
            </div>
            <textarea className="textarea" placeholder="Description (optional)" rows={3}
              value={newDesc} onChange={e => setNewDesc(e.target.value)} />
            {/* Dependency picker */}
            {beads.length > 0 && (
              <div className="form-field">
                <label className="form-label">Dependencies (optional)</label>
                <select
                  className="select"
                  value=""
                  onChange={e => {
                    const id = e.target.value
                    if (id && !newDeps.includes(id)) setNewDeps([...newDeps, id])
                  }}
                >
                  <option value="">Add dependency...</option>
                  {beads
                    .filter(b => !newDeps.includes(b.id))
                    .map(b => (
                      <option key={b.id} value={b.id}>{b.id} — {b.title.slice(0, 60)}</option>
                    ))}
                </select>
                {newDeps.length > 0 && (
                  <div className="dep-tags">
                    {newDeps.map(id => (
                      <span key={id} className="tag tag-dep">
                        {id}
                        <button className="tag-remove" onClick={() => setNewDeps(newDeps.filter(d => d !== id))}>
                          {'\u2715'}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="form-actions">
              <AsyncButton className="btn-primary" onClick={createBead} disabled={!newTitle.trim()}
                pendingContent="Creating\u2026">Create</AsyncButton>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit panel */}
      {editing && (
        <div className="card card-edit animate-slide-down">
          <div className="card-header-bar">
            <h3>Edit: {editing.id}</h3>
            <div className="header-actions">
              <AsyncButton className="btn-sm btn-primary" onClick={saveEdit}
                pendingContent="Saving\u2026">Save</AsyncButton>
              <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
          <div className="form-grid">
            <input className="input" value={editTitle} onChange={e => setEditTitle(e.target.value)}
              placeholder="Title" />
            <textarea className="textarea" value={editDesc} onChange={e => setEditDesc(e.target.value)}
              placeholder="Description" rows={3} />
          </div>
        </div>
      )}

      {/* Sort bar */}
      <div className="sort-bar">
            <span className="sort-label">Sort by:</span>
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.id}
                className={`btn btn-xs ${sortBy === opt.id ? 'btn-sort-active' : 'btn-ghost'}`}
                onClick={() => toggleSort(opt.id)}
              >
                {opt.label}
                {sortBy === opt.id && (
                  <span className="sort-arrow">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
                )}
              </button>
            ))}
          </div>

          {/* Bead list */}
          <div className="bead-list">
            {sortedBeads.length === 0 && !loading && (
              <div className="empty-state">
                <span className="empty-icon">{'\u29BE'}</span>
                <h3>No beads</h3>
                <p>Create a bead or inject a plan via the Swarm page.</p>
              </div>
            )}
            {sortedBeads.map((bead, idx) => (
              <BeadCard
                key={bead.id}
                bead={bead}
                projectPath={projectPath}
                expanded={expandedBead === bead.id}
                onToggleExpand={toggleDetail}
                commentCount={commentCounts.get(bead.id) ?? 0}
                locks={locksByBead.get(bead.id) ?? []}
                onClaim={claimBead}
                onClose={closeBead}
                onReopen={reopenBead}
                onRollback={rollbackBead}
                onForceUnlock={forceUnlock}
                onChangePriority={changePriority}
                onStartEdit={startEdit}
                index={idx}
                isDragging={dragIdx === idx}
                isDropTarget={dropIdx === idx}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
              />
            ))}
          </div>
    </div>
  )
}
