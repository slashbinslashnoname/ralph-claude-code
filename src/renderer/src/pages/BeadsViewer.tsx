import React, { useCallback, useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type BdTask = Record<string, unknown> & {
  id: string
  title: string
  status?: string
  priority?: number | string
  type?: string
  description?: string
  labels?: string[]
  assignee?: string
}

type Filter = 'open' | 'in_progress' | 'closed' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open',        label: 'Open' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'closed',      label: 'Closed' },
  { id: 'all',         label: 'All' },
]

const TYPES    = ['task', 'bug', 'feature', 'chore']
const PRIORITIES = [0, 1, 2, 3, 4]

// ── Small helpers ─────────────────────────────────────────────────────────────

function statusColor(status?: string): string {
  if (status === 'open')        return 'var(--green)'
  if (status === 'in_progress') return 'var(--yellow)'
  if (status === 'closed')      return 'var(--muted)'
  return 'var(--accent)'
}

function priorityLabel(p?: number | string): string {
  if (p === undefined || p === null) return ''
  return `P${p}`
}

// ── Create / Edit modal ───────────────────────────────────────────────────────

function BeadModal({
  projectPath, task, onDone, onClose
}: {
  projectPath: string
  task?: BdTask         // if set → edit mode (only priority + labels for now)
  onDone: () => void
  onClose: () => void
}): JSX.Element {
  const isEdit = !!task

  const [title,       setTitle]       = useState(task?.title ?? '')
  const [type,        setType]        = useState(task?.type  ?? 'task')
  const [priority,    setPriority]    = useState<number>(
    task?.priority !== undefined ? Number(task.priority) : 2
  )
  const [description, setDescription] = useState(task?.description ?? '')
  const [labels,      setLabels]      = useState((task?.labels ?? []).join(', '))
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (!title.trim() && !isEdit) { setError('Title is required'); return }
    setSaving(true)
    setError(null)

    const labelList = labels.split(',').map(l => l.trim()).filter(Boolean)

    let r: { ok: boolean; error?: string }
    if (isEdit) {
      const existingLabels = task!.labels ?? []
      const toAdd    = labelList.filter(l => !existingLabels.includes(l))
      const toRemove = existingLabels.filter(l => !labelList.includes(l))
      r = await window.ralph.beads.update(projectPath, task!.id, {
        priority,
        labelsAdd:    toAdd.length    ? toAdd    : undefined,
        labelsRemove: toRemove.length ? toRemove : undefined,
      })
    } else {
      r = await window.ralph.beads.create(projectPath, {
        title: title.trim(),
        type,
        priority,
        description: description.trim() || undefined,
        labels: labelList.length ? labelList : undefined,
      })
    }

    setSaving(false)
    if (!r.ok) { setError(r.error ?? 'Unknown error'); return }
    onDone()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box',
    background: 'var(--surface2)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', padding: '7px 10px',
    fontFamily: 'monospace', fontSize: 12, outline: 'none',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--muted)', marginBottom: 4, display: 'block'
  }
  const rowStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 24, width: 440, display: 'flex', flexDirection: 'column', gap: 14
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
          {isEdit ? `Edit ${task!.id}` : 'New Bead'}
        </div>

        {!isEdit && (
          <div style={rowStyle}>
            <label style={labelStyle}>Title *</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="What needs to be done?" style={inputStyle}
              onKeyDown={e => e.key === 'Enter' && void submit()} autoFocus />
          </div>
        )}

        {!isEdit && (
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ ...rowStyle, flex: 1 }}>
              <label style={labelStyle}>Type</label>
              <select value={type} onChange={e => setType(e.target.value)} style={inputStyle}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ ...rowStyle, width: 80 }}>
              <label style={labelStyle}>Priority</label>
              <select value={priority} onChange={e => setPriority(Number(e.target.value))} style={inputStyle}>
                {PRIORITIES.map(p => <option key={p} value={p}>P{p}</option>)}
              </select>
            </div>
          </div>
        )}

        {isEdit && (
          <div style={{ ...rowStyle, width: 80 }}>
            <label style={labelStyle}>Priority</label>
            <select value={priority} onChange={e => setPriority(Number(e.target.value))} style={inputStyle}>
              {PRIORITIES.map(p => <option key={p} value={p}>P{p}</option>)}
            </select>
          </div>
        )}

        {!isEdit && (
          <div style={rowStyle}>
            <label style={labelStyle}>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)}
              rows={3} style={{ ...inputStyle, resize: 'vertical' }}
              placeholder="Optional details…" />
          </div>
        )}

        <div style={rowStyle}>
          <label style={labelStyle}>Labels (comma-separated)</label>
          <input value={labels} onChange={e => setLabels(e.target.value)}
            placeholder="e.g. bug, critical" style={inputStyle} />
        </div>

        {error && (
          <div style={{ fontSize: 12, color: '#f87171' }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={saving}>
            {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : (isEdit ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Bead row ──────────────────────────────────────────────────────────────────

function BeadRow({
  task, projectPath, onRefresh
}: {
  task: BdTask
  projectPath: string
  onRefresh: () => void
}): JSX.Element {
  const [editing,  setEditing]  = useState(false)
  const [busy,     setBusy]     = useState(false)
  const [expanded, setExpanded] = useState(false)

  const isClosed = task.status === 'closed'

  const handleClose = async (): Promise<void> => {
    setBusy(true)
    await window.ralph.beads.close(projectPath, task.id, 'Done')
    setBusy(false)
    onRefresh()
  }

  const handleReopen = async (): Promise<void> => {
    setBusy(true)
    await window.ralph.beads.reopen(projectPath, task.id)
    setBusy(false)
    onRefresh()
  }

  return (
    <>
      {editing && (
        <BeadModal
          projectPath={projectPath}
          task={task}
          onDone={() => { setEditing(false); onRefresh() }}
          onClose={() => setEditing(false)}
        />
      )}
      <div style={{
        borderBottom: '1px solid var(--border)', padding: '10px 16px',
        display: 'flex', alignItems: 'flex-start', gap: 12,
        opacity: isClosed ? 0.55 : 1,
      }}>
        {/* Status dot */}
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor(task.status), marginTop: 6, flexShrink: 0
        }} />

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'monospace' }}>{task.id}</span>
            {task.type && (
              <span style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--surface2)', borderRadius: 4, padding: '1px 5px' }}>
                {String(task.type)}
              </span>
            )}
            {task.priority !== undefined && (
              <span style={{ fontSize: 11, color: 'var(--yellow)' }}>{priorityLabel(task.priority)}</span>
            )}
            {(task.labels as string[] | undefined)?.map(l => (
              <span key={l} style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface2)', borderRadius: 4, padding: '1px 5px' }}>
                {l}
              </span>
            ))}
          </div>
          <div
            style={{ fontSize: 13, color: 'var(--text)', marginTop: 3, cursor: task.description ? 'pointer' : 'default',
              textDecoration: isClosed ? 'line-through' : 'none' }}
            onClick={() => task.description && setExpanded(e => !e)}
          >
            {task.title}
          </div>
          {expanded && task.description && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
              {String(task.description)}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
            onClick={() => setEditing(true)} disabled={busy} title="Edit">
            ✎
          </button>
          {isClosed ? (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
              onClick={() => void handleReopen()} disabled={busy} title="Reopen">
              ↩
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--muted)' }}
              onClick={() => void handleClose()} disabled={busy} title="Close">
              ✕
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BeadsViewer({ projectPath: externalPath }: { projectPath?: string | null } = {}): JSX.Element {
  const [projectPath, setProjectPath] = useState<string | null>(externalPath ?? null)
  useEffect(() => { if (externalPath !== undefined) setProjectPath(externalPath) }, [externalPath])

  const [available,        setAvailable]        = useState<boolean | null>(null)
  const [unavailableReason, setUnavailableReason] = useState('')
  const [filter,           setFilter]           = useState<Filter>('open')
  const [tasks,            setTasks]            = useState<BdTask[]>([])
  const [loading,          setLoading]          = useState(false)
  const [error,            setError]            = useState<string | null>(null)
  const [search,           setSearch]           = useState('')
  const [creating,         setCreating]         = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const checkAndLoad = useCallback(async (path: string): Promise<void> => {
    const result = await window.ralph.beads.check(path)
    setAvailable(result.available)
    if (!result.available) setUnavailableReason((result as { available: false; reason: string }).reason)
  }, [])

  const selectProject = useCallback(async () => {
    const path = await window.ralph.selectProject()
    if (!path) return
    setProjectPath(path); setTasks([]); setError(null); setAvailable(null)
    await checkAndLoad(path)
  }, [checkAndLoad])

  useEffect(() => {
    if (projectPath && available === null) void checkAndLoad(projectPath)
  }, [projectPath, available, checkAndLoad])

  const fetchTasks = useCallback(async () => {
    if (!projectPath || !available) return
    setLoading(true); setError(null)
    const result = await window.ralph.beads.list(projectPath, filter)
    setLoading(false)
    if (result.ok) setTasks(result.tasks as BdTask[])
    else { setError(result.error); setTasks([]) }
  }, [projectPath, available, filter])

  useEffect(() => { void fetchTasks() }, [fetchTasks])

  useEffect(() => {
    if (!projectPath || !available) return
    intervalRef.current = setInterval(fetchTasks, 15_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [projectPath, available, fetchTasks])

  const visible = tasks.filter(t =>
    !search ||
    t.title.toLowerCase().includes(search.toLowerCase()) ||
    t.id.toLowerCase().includes(search.toLowerCase())
  )

  const counts = {
    open:        tasks.filter(t => t.status === 'open').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    closed:      tasks.filter(t => t.status === 'closed').length,
    all:         tasks.length,
  }

  return (
    <>
      {creating && projectPath && (
        <BeadModal
          projectPath={projectPath}
          onDone={() => { setCreating(false); void fetchTasks() }}
          onClose={() => setCreating(false)}
        />
      )}

      <div className="page-header">
        <div>
          <div className="page-title">◎ Beads</div>
          <div className="page-sub" style={{ fontFamily: 'monospace' }}>{projectPath ?? 'No project'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {projectPath && available && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => void fetchTasks()} disabled={loading} title="Refresh">
                {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↻'} Refresh
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + New Bead
              </button>
            </>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => void selectProject()}>⊕ Project</button>
        </div>
      </div>

      {/* No project */}
      {!projectPath && (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">📂</div>
          <div className="state-title">No project selected</div>
          <div className="state-desc">Open a project with <code>bd init</code> already run.</div>
          <button className="btn btn-primary" onClick={() => void selectProject()}>⊕ Open project</button>
        </div>
      )}

      {/* Beads unavailable */}
      {projectPath && available === false && (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">⚠</div>
          <div className="state-title">Beads not available</div>
          <div className="state-desc">{unavailableReason}</div>
          <div className="state-code">bd init</div>
        </div>
      )}

      {/* Checking */}
      {projectPath && available === null && (
        <div className="state-box" style={{ flex: 1 }}>
          <span className="spinner" /><div className="state-desc">Checking…</div>
        </div>
      )}

      {/* Error */}
      {projectPath && available && error && (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">✗</div>
          <div className="state-title">Failed to fetch tasks</div>
          <div className="state-desc">{error}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => void fetchTasks()}>Retry</button>
        </div>
      )}

      {/* Filter + search */}
      {projectPath && available && !error && (
        <>
          <div className="filter-bar" style={{ gap: 8, alignItems: 'center' }}>
            {FILTERS.map(f => (
              <button key={f.id}
                className={`filter-tab${filter === f.id ? ' active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                {counts[f.id] > 0 && ` (${counts[f.id]})`}
              </button>
            ))}
            <input type="search" placeholder="Search…" value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                marginLeft: 'auto', padding: '5px 10px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                color: 'var(--text)', fontSize: 12, outline: 'none', width: 180
              }}
            />
          </div>

          {loading && tasks.length === 0 ? (
            <div className="state-box" style={{ flex: 1 }}>
              <span className="spinner" /><div className="state-desc">Loading…</div>
            </div>
          ) : visible.length === 0 ? (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-icon">✓</div>
              <div className="state-title">No beads</div>
              <div className="state-desc">
                {search ? 'Nothing matches your search.' : `No ${filter.replace('_', ' ')} beads.`}
              </div>
              {!search && (
                <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ New Bead</button>
              )}
            </div>
          ) : (
            <>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {visible.map(task => (
                  <BeadRow key={task.id} task={task} projectPath={projectPath!} onRefresh={() => void fetchTasks()} />
                ))}
              </div>
              <div className="summary-bar">
                {visible.length} of {tasks.length} bead{tasks.length !== 1 ? 's' : ''}
                {loading && ' · refreshing…'}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
