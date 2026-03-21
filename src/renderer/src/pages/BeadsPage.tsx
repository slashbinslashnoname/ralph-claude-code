import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sortBeads, SORT_OPTIONS, type SortField, type SortDirection } from '../utils/sortBeads'
import BeadDetailPanel from '../components/BeadDetailPanel'
import TreeBrowser from '../components/TreeBrowser'
import type { DAGBead } from '../components/TreeBrowser'
import KanbanBoard from '../components/KanbanBoard'
import type { Bead, PlanQueueItem } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

type BeadFilter = 'all' | 'open' | 'in_progress' | 'closed'

const TABS: { id: BeadFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'closed', label: 'Closed' },
]

export default function BeadsPage({ projectPath }: Props) {
  const [beads, setBeads] = useState<Bead[]>([])
  const [filter, setFilter] = useState<BeadFilter>('all')
  const [bdAvailable, setBdAvailable] = useState(true)
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newType, setNewType] = useState('task')
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
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'tree' | 'kanban'>('list')

  const refresh = useCallback(async () => {
    setLoading(true)
    const check = await sb.beads.check(projectPath)
    setBdAvailable(check.available)
    if (check.available) {
      const r = await sb.beads.list(projectPath, filter === 'all' ? 'all' : filter)
      if (r.ok) setBeads(r.tasks)
    }
    setLoading(false)
  }, [projectPath, filter])

  useEffect(() => { refresh() }, [refresh])

  // Plan inject listeners
  useEffect(() => {
    sb.swarm.status(projectPath).then(s => {
      setIsPlanning(s.planning ?? false)
      setPlanRequest(s.planRequest ?? '')
    })
    sb.swarm.queue(projectPath).then(setPlanQueue)
    const unsubs = [
      sb.swarm.onPlanPhase((_p: string, phase: string, request: string) => {
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
    // Status updates come via onPlanPhase/onPlanQueue listeners
  }, [projectPath, planPrompt])

  const createBead = useCallback(async () => {
    if (!newTitle.trim()) return
    const r = await sb.beads.create(projectPath, {
      title: newTitle, type: newType, priority: newPriority,
      description: newDesc || undefined,
      deps: newDeps.length > 0 ? newDeps : undefined,
    })
    if (r.ok) {
      setNewTitle(''); setNewDesc(''); setNewDeps([]); setShowCreate(false)
      refresh()
    }
  }, [projectPath, newTitle, newDesc, newType, newPriority, newDeps, refresh])

  const claimBead = useCallback(async (id: string) => {
    await sb.beads.update(projectPath, id, { claim: true })
    refresh()
  }, [projectPath, refresh])

  const closeBead = useCallback(async (id: string) => {
    await sb.beads.close(projectPath, id, 'Done')
    refresh()
  }, [projectPath, refresh])

  const reopenBead = useCallback(async (id: string) => {
    await sb.beads.reopen(projectPath, id, 'Back to open')
    refresh()
  }, [projectPath, refresh])

  const rollbackBead = useCallback(async (id: string) => {
    setRollingBack(id)
    try {
      await sb.beads.rollback(projectPath, id)
    } finally {
      setRollingBack(null)
      refresh()
    }
  }, [projectPath, refresh])

  const changePriority = useCallback(async (id: string, priority: number) => {
    await sb.beads.update(projectPath, id, { priority })
    refresh()
  }, [projectPath, refresh])

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
      await sb.beads.update(projectPath, editing.id, updates)
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

  const dagBeads: DAGBead[] = useMemo(() => beads.map(b => ({
    id: b.id,
    title: b.title,
    status: b.status,
    deps: b.deps ?? [],
    epicId: b.epicId,
  })), [beads])

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
      await Promise.all(updates)
      refresh()
    }
  }, [sortedBeads, projectPath, refresh])

  // Count beads per status for tab badges
  const counts = {
    all: beads.length,
    open: 0, in_progress: 0, closed: 0
  }
  // We re-count from the "all" set if on all tab, otherwise just show current
  // For simplicity, we always show the current list length

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

  const statusColor = (s: string) => {
    if (s === 'done') return 'success'
    if (s === 'claimed') return 'warning'
    if (s === 'ready') return 'info'
    if (s === 'failed') return 'danger'
    return 'idle'
  }

  const statusLabel = (s: string) => {
    if (s === 'ready') return 'open'
    if (s === 'claimed') return 'in progress'
    if (s === 'done') return 'closed'
    return s
  }

  return (
    <div className="page">
      <header className="page-header">
        <h2>Beads</h2>
        <div className="header-actions">
          <div className="view-toggle">
            <button
              className={`btn btn-xs ${viewMode === 'list' ? 'btn-sort-active' : 'btn-ghost'}`}
              onClick={() => setViewMode('list')}
              data-testid="view-mode-list"
            >
              List
            </button>
            <button
              className={`btn btn-xs ${viewMode === 'kanban' ? 'btn-sort-active' : 'btn-ghost'}`}
              onClick={() => setViewMode('kanban')}
              data-testid="view-mode-kanban"
            >
              Kanban
            </button>
            <button
              className={`btn btn-xs ${viewMode === 'tree' ? 'btn-sort-active' : 'btn-ghost'}`}
              onClick={() => setViewMode('tree')}
              data-testid="view-mode-tree"
            >
              Tree
            </button>
          </div>
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
          <button className="btn btn-primary" onClick={injectPlan} disabled={!planPrompt.trim()}>
            {isPlanning ? `+ Queue Plan (${planQueue.length + 1})` : 'Inject Plan'}
          </button>
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
              <select className="select" value={newType} onChange={e => setNewType(e.target.value)}>
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
              <button className="btn btn-primary" onClick={createBead} disabled={!newTitle.trim()}>Create</button>
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
              <button className="btn btn-sm btn-primary" onClick={saveEdit}>Save</button>
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

      {viewMode === 'list' && (
        <>
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
              <div key={bead.id}
                className={`bead-card${dragIdx === idx ? ' bead-dragging' : ''}${dropIdx === idx ? ' bead-drop-target' : ''}`}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}>
                <div className="bead-card-header">
                  <span className={`badge badge-${statusColor(bead.status)}`}>{statusLabel(bead.status)}</span>
                  <span className="bead-id">{bead.id}</span>
                  <span className="bead-type-tag">{bead.type}</span>
                  <span className="bead-spacer" />

                  <select className={`select select-xs priority-select p${bead.priority}`}
                    value={bead.priority}
                    onChange={e => changePriority(bead.id, Number(e.target.value))}>
                    <option value={0}>P0</option>
                    <option value={1}>P1</option>
                    <option value={2}>P2</option>
                    <option value={3}>P3</option>
                    <option value={4}>P4</option>
                  </select>
                </div>

                <h4 className="bead-title">{bead.title}</h4>
                {bead.description && <p className="bead-desc">{bead.description.slice(0, 200)}</p>}

                {bead.tags?.length > 0 && (
                  <div className="bead-meta">
                    {bead.tags.map((t: string) => <span key={t} className="tag">{t}</span>)}
                  </div>
                )}

                <div className="bead-actions">
                  {bead.status === 'ready' && (
                    <>
                      <button className="btn btn-xs btn-info" onClick={() => claimBead(bead.id)}>Claim</button>
                      <button className="btn btn-xs btn-success" onClick={() => closeBead(bead.id)}>Close</button>
                    </>
                  )}
                  {bead.status === 'claimed' && (
                    <>
                      <button className="btn btn-xs btn-ghost" onClick={() => reopenBead(bead.id)}>Back to Open</button>
                      <button className="btn btn-xs btn-success" onClick={() => closeBead(bead.id)}>Close</button>
                    </>
                  )}
                  {bead.status === 'done' && (
                    <>
                      <button className="btn btn-xs btn-warning" onClick={() => reopenBead(bead.id)}>Reopen</button>
                      <button
                        className="btn btn-xs btn-danger"
                        onClick={() => rollbackBead(bead.id)}
                        disabled={rollingBack === bead.id}
                      >
                        {rollingBack === bead.id ? 'Rolling back\u2026' : 'Rollback'}
                      </button>
                    </>
                  )}
                  {bead.status === 'failed' && (
                    <button className="btn btn-xs btn-warning" onClick={() => reopenBead(bead.id)}>Retry</button>
                  )}
                  {bead.status === 'pending' && (
                    <button className="btn btn-xs btn-ghost" onClick={() => reopenBead(bead.id)}>Unblock</button>
                  )}

                  <span className="bead-action-spacer" />
                  <button className="btn btn-xs btn-ghost" onClick={() => startEdit(bead)}>Edit</button>
                  <button className="btn btn-xs btn-ghost" onClick={() => toggleDetail(bead.id)}>
                    {expandedBead === bead.id ? 'Hide Detail' : 'Detail'}
                  </button>
                  {bead.claimedBy && <span className="tag tag-agent">{bead.claimedBy}</span>}
                </div>

                {/* Bead detail panel with audit trail */}
                {expandedBead === bead.id && (
                  <BeadDetailPanel
                    beadId={bead.id}
                    beadStatus={bead.status}
                    projectPath={projectPath}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {viewMode === 'kanban' && (
        <>
          <KanbanBoard
            beads={beads}
            onClaimBead={claimBead}
            onCloseBead={closeBead}
            onReopenBead={reopenBead}
            onSelectBead={toggleDetail}
            selectedBeadId={expandedBead}
          />
          {expandedBead && beads.find(b => b.id === expandedBead) && (
            <BeadDetailPanel
              beadId={expandedBead}
              beadStatus={beads.find(b => b.id === expandedBead)!.status}
              projectPath={projectPath}
            />
          )}
        </>
      )}

      {viewMode === 'tree' && (
        <>
          <TreeBrowser
            beads={dagBeads}
            selectedBeadId={expandedBead}
            onSelectBead={toggleDetail}
          />
          {expandedBead && beads.find(b => b.id === expandedBead) && (
            <BeadDetailPanel
              beadId={expandedBead}
              beadStatus={beads.find(b => b.id === expandedBead)!.status}
              projectPath={projectPath}
            />
          )}
        </>
      )}
    </div>
  )
}
