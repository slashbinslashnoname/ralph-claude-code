/**
 * BeadsViewer — reads beads from the SQLite store (fast).
 *
 * Status values: pending | ready | claimed | done | failed
 * Auto-refreshes every 5 s when any workers are active.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type BeadStatus = 'pending' | 'ready' | 'claimed' | 'done' | 'failed'

interface Bead {
  id:           string
  title:        string
  description?: string
  type?:        string
  status:       BeadStatus
  priority?:    number
  tags?:        string[]
  claimedBy?:   string
  files?:       string[]
  deps?:        string[]
}

interface BeadStats {
  total: number; pending: number; ready: number
  claimed: number; done: number; failed: number; pct: number
}

type Filter = 'ready' | 'pending' | 'claimed' | 'done' | 'failed' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ready',   label: 'Ready' },
  { id: 'claimed', label: 'In Progress' },
  { id: 'pending', label: 'Pending' },
  { id: 'done',    label: 'Done' },
  { id: 'failed',  label: 'Failed' },
  { id: 'all',     label: 'All' },
]

function statusColor(status?: string): string {
  if (status === 'ready')   return 'var(--green)'
  if (status === 'claimed') return 'var(--yellow)'
  if (status === 'done')    return 'var(--accent)'
  if (status === 'failed')  return '#e06c75'
  return 'var(--muted)'
}

// ── Bead row ──────────────────────────────────────────────────────────────────

function BeadRow({ bead }: { bead: Bead }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isClosed = bead.status === 'done' || bead.status === 'failed'

  return (
    <div style={{
      borderBottom: '1px solid var(--border)', padding: '10px 16px',
      display: 'flex', alignItems: 'flex-start', gap: 10,
      opacity: isClosed ? 0.55 : 1,
    }}>
      {/* Status dot */}
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: statusColor(bead.status), marginTop: 6, flexShrink: 0
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Meta row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{bead.id}</span>
          {bead.type && (
            <span style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--surface2)', borderRadius: 4, padding: '1px 5px' }}>
              {bead.type}
            </span>
          )}
          {bead.priority !== undefined && (
            <span style={{ fontSize: 11, color: 'var(--yellow)' }}>P{bead.priority}</span>
          )}
          {bead.claimedBy && (
            <span style={{ fontSize: 11, color: 'var(--yellow)', background: 'var(--surface2)', borderRadius: 4, padding: '1px 5px' }}>
              ⚡ {bead.claimedBy}
            </span>
          )}
          {bead.tags?.map(t => (
            <span key={t} style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface2)', borderRadius: 4, padding: '1px 5px' }}>
              {t}
            </span>
          ))}
        </div>
        {/* Title */}
        <div
          style={{ fontSize: 13, color: 'var(--text)', marginTop: 3, cursor: bead.description ? 'pointer' : 'default',
            textDecoration: isClosed ? 'line-through' : 'none' }}
          onClick={() => bead.description && setExpanded(e => !e)}
        >
          {bead.title}
        </div>
        {/* Expanded description */}
        {expanded && bead.description && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {bead.description}
          </div>
        )}
        {/* Files */}
        {expanded && bead.files && bead.files.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {bead.files.map(f => (
              <span key={f} style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace',
                background: 'var(--surface2)', borderRadius: 3, padding: '1px 4px' }}>{f}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: BeadStats }): JSX.Element {
  const segments: Array<{ key: keyof BeadStats; color: string }> = [
    { key: 'done',    color: 'var(--accent)' },
    { key: 'claimed', color: 'var(--yellow)' },
    { key: 'ready',   color: 'var(--green)' },
    { key: 'pending', color: 'var(--muted)' },
    { key: 'failed',  color: '#e06c75' },
  ]
  return (
    <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Progress bar */}
      <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
        {stats.total > 0 && segments.map(({ key, color }) => {
          const pct = ((stats[key] as number) / stats.total) * 100
          return pct > 0 ? <div key={key} style={{ width: `${pct}%`, background: color }} /> : null
        })}
      </div>
      {/* Counts */}
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--muted)' }}>
        <span><span style={{ color: 'var(--accent)' }}>✓ {stats.done}</span> done</span>
        <span><span style={{ color: 'var(--yellow)' }}>⚡ {stats.claimed}</span> active</span>
        <span><span style={{ color: 'var(--green)' }}>◎ {stats.ready}</span> ready</span>
        <span>{stats.pending} pending</span>
        {stats.failed > 0 && <span style={{ color: '#e06c75' }}>✗ {stats.failed} failed</span>}
        <span style={{ marginLeft: 'auto' }}>{stats.pct}% complete</span>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BeadsViewer({ projectPath: externalPath }: { projectPath?: string | null } = {}): JSX.Element {
  const [projectPath, setProjectPath] = useState<string | null>(externalPath ?? null)
  useEffect(() => { if (externalPath !== undefined) setProjectPath(externalPath) }, [externalPath])

  const [filter,  setFilter]  = useState<Filter>('ready')
  const [beads,   setBeads]   = useState<Bead[]>([])
  const [stats,   setStats]   = useState<BeadStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [search,  setSearch]  = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchBeads = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    const [beadList, beadStats] = await Promise.all([
      window.ralph.swarm.beads(projectPath, filter === 'all' ? undefined : filter),
      window.ralph.swarm.beadStats(projectPath),
    ])
    setLoading(false)
    setBeads((beadList as Bead[]) ?? [])
    setStats(beadStats as BeadStats ?? null)
  }, [projectPath, filter])

  useEffect(() => { void fetchBeads() }, [fetchBeads])

  // Auto-refresh every 5 s
  useEffect(() => {
    if (!projectPath) return
    intervalRef.current = setInterval(() => void fetchBeads(), 5_000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [projectPath, fetchBeads])

  // Also refresh on graph broadcasts (bead state changes)
  useEffect(() => {
    return window.ralph.swarm.onGraph((p) => {
      if (p === projectPath) void fetchBeads()
    })
  }, [projectPath, fetchBeads])

  const selectProject = async (): Promise<void> => {
    const path = await window.ralph.selectProject()
    if (!path) return
    setProjectPath(path); setBeads([]); setStats(null)
  }

  const visible = beads.filter(b =>
    !search ||
    b.title.toLowerCase().includes(search.toLowerCase()) ||
    b.id.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">◎ Beads</div>
          <div className="page-sub" style={{ fontFamily: 'monospace' }}>{projectPath ?? 'No project'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {projectPath && (
            <button className="btn btn-ghost btn-sm" onClick={() => void fetchBeads()} disabled={loading} title="Refresh">
              {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↻'} Refresh
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => void selectProject()}>⊕ Project</button>
        </div>
      </div>

      {!projectPath ? (
        <div className="state-box" style={{ flex: 1 }}>
          <div className="state-icon">📂</div>
          <div className="state-title">No project selected</div>
          <button className="btn btn-primary" onClick={() => void selectProject()}>⊕ Open project</button>
        </div>
      ) : (
        <>
          {stats && stats.total > 0 && <StatsBar stats={stats} />}

          {/* Filter + search bar */}
          <div className="filter-bar" style={{ gap: 8, alignItems: 'center' }}>
            {FILTERS.map(f => {
              const count = stats ? (f.id === 'all' ? stats.total : (stats[f.id as keyof BeadStats] as number | undefined) ?? 0) : 0
              return (
                <button key={f.id}
                  className={`filter-tab${filter === f.id ? ' active' : ''}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}{count > 0 ? ` (${count})` : ''}
                </button>
              )
            })}
            <input type="search" placeholder="Search…" value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                marginLeft: 'auto', padding: '5px 10px', borderRadius: 6,
                border: '1px solid var(--border)', background: 'var(--surface2)',
                color: 'var(--text)', fontSize: 12, outline: 'none', width: 180,
              }} />
          </div>

          {/* Empty state */}
          {!loading && visible.length === 0 && stats?.total === 0 && (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-icon">◎</div>
              <div className="state-title">No beads yet</div>
              <div className="state-desc">Submit a plan request to generate beads.</div>
            </div>
          )}

          {!loading && visible.length === 0 && (stats?.total ?? 0) > 0 && (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-desc">No beads match filter / search.</div>
            </div>
          )}

          {/* Bead list */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {visible.map(b => <BeadRow key={b.id} bead={b} />)}
          </div>
        </>
      )}
    </>
  )
}
