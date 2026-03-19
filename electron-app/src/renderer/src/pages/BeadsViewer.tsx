import React, { useCallback, useEffect, useRef, useState } from 'react'
import TaskCard from '../components/TaskCard'

type BeadsTask = {
  id: string
  title: string
  status: string
  priority?: string
  tags: string[]
}

type Filter = 'open' | 'in_progress' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open',        label: 'Open' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'all',         label: 'All' }
]

export default function BeadsViewer(): JSX.Element {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [unavailableReason, setUnavailableReason] = useState('')
  const [filter, setFilter] = useState<Filter>('open')
  const [tasks, setTasks] = useState<BeadsTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Project selection ──────────────────────────────────────
  const selectProject = useCallback(async () => {
    const path = await window.ralph.selectProject()
    if (!path) return
    setProjectPath(path)
    setTasks([])
    setError(null)
    setAvailable(null)

    const result = await window.ralph.beads.check(path)
    setAvailable(result.available)
    if (!result.available) setUnavailableReason((result as { available: false; reason: string }).reason)
  }, [])

  // ── Fetch tasks ────────────────────────────────────────────
  const fetchTasks = useCallback(async () => {
    if (!projectPath || !available) return
    setLoading(true)
    setError(null)

    const result = await window.ralph.beads.fetch(projectPath, filter)
    setLoading(false)

    if (result.ok) {
      setTasks(result.tasks)
    } else {
      setError(result.error)
      setTasks([])
    }
  }, [projectPath, available, filter])

  // Fetch when filter or availability changes
  useEffect(() => { fetchTasks() }, [fetchTasks])

  // Auto-refresh every 10 s when a project is open
  useEffect(() => {
    if (!projectPath || !available) return
    intervalRef.current = setInterval(fetchTasks, 10_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [projectPath, available, fetchTasks])

  // ── Filtered + searched task list ─────────────────────────
  const visible = tasks.filter(t =>
    !search ||
    t.title.toLowerCase().includes(search.toLowerCase()) ||
    t.id.toLowerCase().includes(search.toLowerCase())
  )

  const counts = {
    open:        tasks.filter(t => t.status === 'open').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    total:       tasks.length
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">◎ Beads Tasks</div>
          <div className="page-sub">Issue tracker powered by the <code>bd</code> CLI</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {projectPath && available && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={fetchTasks}
              disabled={loading}
              title="Refresh"
            >
              {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↻'} Refresh
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={selectProject}>
            ⊕ Open project
          </button>
        </div>
      </div>

      {/* ── Project bar ── */}
      {projectPath && (
        <div className="project-bar">
          <span className="project-path">{projectPath}</span>
          {available === null && <span className="badge" style={{ background: '#1e1b4b', color: '#818cf8' }}>checking…</span>}
          {available === true  && <span className="badge badge-available">✓ Beads</span>}
          {available === false && <span className="badge badge-unavailable">✗ Unavailable</span>}
        </div>
      )}

      {/* ── No project selected ── */}
      {!projectPath && (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">📂</div>
          <div className="state-title">No project selected</div>
          <div className="state-desc">
            Open a Ralph-managed project folder that has a <code>.beads/</code> directory and <code>bd</code> on your PATH.
          </div>
          <button className="btn btn-primary" onClick={selectProject}>
            ⊕ Open project
          </button>
        </div>
      )}

      {/* ── Beads unavailable ── */}
      {projectPath && available === false && (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">⚠️</div>
          <div className="state-title">Beads not available</div>
          <div className="state-desc">{unavailableReason}</div>
          <div className="state-code">ralph-enable --from beads</div>
        </div>
      )}

      {/* ── Error ── */}
      {projectPath && available && error && (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">✗</div>
          <div className="state-title">Failed to fetch tasks</div>
          <div className="state-desc">{error}</div>
          <button className="btn btn-ghost btn-sm" onClick={fetchTasks}>Retry</button>
        </div>
      )}

      {/* ── Filter + search bar ── */}
      {projectPath && available && !error && (
        <>
          <div className="filter-bar" style={{ gap: 8, alignItems: 'center' }}>
            {FILTERS.map(f => (
              <button
                key={f.id}
                className={`filter-tab${filter === f.id ? ' active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                {f.id === 'open'        && counts.open        > 0 && ` (${counts.open})`}
                {f.id === 'in_progress' && counts.in_progress > 0 && ` (${counts.in_progress})`}
                {f.id === 'all'         && counts.total        > 0 && ` (${counts.total})`}
              </button>
            ))}
            <input
              type="search"
              placeholder="Search tasks…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                marginLeft: 'auto', padding: '5px 10px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                color: 'var(--text)', fontSize: 12, outline: 'none', width: 180
              }}
            />
          </div>

          {/* ── Task list ── */}
          {loading && tasks.length === 0 ? (
            <div className="state-box" style={{ flex: 1 }}>
              <span className="spinner" />
              <div className="state-desc">Loading tasks…</div>
            </div>
          ) : visible.length === 0 ? (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-icon">✓</div>
              <div className="state-title">No tasks</div>
              <div className="state-desc">
                {search ? 'No tasks match your search.' : `No ${filter.replace('_', ' ')} tasks found.`}
              </div>
            </div>
          ) : (
            <>
              <div className="task-list">
                {visible.map(task => <TaskCard key={task.id} task={task} />)}
              </div>
              <div className="summary-bar">
                Showing {visible.length} of {tasks.length} task{tasks.length !== 1 ? 's' : ''}
                {loading && ' · refreshing…'}
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}
