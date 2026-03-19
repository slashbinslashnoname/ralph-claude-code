/**
 * SwarmDashboard — control panel for the multi-agent swarm.
 *
 * Layout:
 *   ┌──────────────────────────┬──────────────────────┐
 *   │  Swarm controls          │  Bead graph stats    │
 *   │  Plan / Start / Stop     │  Progress bar        │
 *   ├──────────────────────────┤                      │
 *   │  Inject new tasks        ├──────────────────────┤
 *   │  textarea + button       │  Agent status cards  │
 *   ├──────────────────────────┤  (one per worker)    │
 *   │  Agent mail log          │                      │
 *   │  (last 20 messages)      │                      │
 *   └──────────────────────────┴──────────────────────┘
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────

interface SwarmStats {
  total: number; pending: number; ready: number
  claimed: number; done: number; failed: number; pct: number
}

interface AgentInfo {
  id: string; index: number; phase: string
  currentBeadId: string | null; loopCount: number; lastActivity: string
}

interface MailMsg {
  ts: string; from: string; type: string
  beadId?: string; files?: string[]; text?: string
}

interface BeadInfo {
  id: string; title: string; type: string; status: string
  priority: number; deps: string[]; files: string[]
  epicId?: string; claimedBy?: string; unblockCount?: number; score?: number
}

interface BeadGraph {
  version: number; createdAt: string; updatedAt: string
  planMd: string; beads: BeadInfo[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PHASE_COLOR: Record<string, string> = {
  idle:      'var(--muted)',
  routing:   'var(--blue)',
  claiming:  'var(--yellow)',
  executing: 'var(--green)',
  reviewing: '#a78bfa',
  closing:   'var(--green)',
  planning:  'var(--yellow)',
  encoding:  'var(--yellow)',
  waiting:   'var(--muted)',
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--muted)', ready: 'var(--blue)',
  claimed: 'var(--yellow)', done: 'var(--green)', failed: 'var(--red)'
}

const TYPE_ICON: Record<string, string> = { epic: '◉', task: '◎', subtask: '·' }

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 5_000)   return 'just now'
  if (diff < 60_000)  return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ProgressRing({ pct }: { pct: number }): JSX.Element {
  const r = 26, circ = 2 * Math.PI * r
  const dash = circ * (1 - pct / 100)
  const color = pct === 100 ? 'var(--green)' : pct > 50 ? 'var(--blue)' : 'var(--yellow)'
  return (
    <svg width={64} height={64} style={{ flexShrink: 0 }}>
      <circle cx={32} cy={32} r={r} fill="none" stroke="var(--surface2)" strokeWidth={5} />
      <circle cx={32} cy={32} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={circ} strokeDashoffset={dash}
        strokeLinecap="round" transform="rotate(-90 32 32)"
        style={{ transition: 'stroke-dashoffset 0.5s' }}
      />
      <text x={32} y={37} textAnchor="middle" fontSize={12} fontWeight={700}
        fill={color}>{pct}%</text>
    </svg>
  )
}

function AgentCard({ agent }: { agent: AgentInfo }): JSX.Element {
  const color = PHASE_COLOR[agent.phase] ?? 'var(--muted)'
  return (
    <div style={{
      background: 'var(--surface2)', border: `1px solid var(--border)`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 8, padding: '10px 14px',
      display: 'flex', flexDirection: 'column', gap: 4
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{agent.id}</span>
        <span style={{ fontSize: 11, color, fontWeight: 600, textTransform: 'uppercase' }}>
          {agent.phase}
        </span>
      </div>
      {agent.currentBeadId && (
        <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
          bead: {agent.currentBeadId}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        loops: {agent.loopCount} · {relTime(agent.lastActivity)}
      </div>
    </div>
  )
}

function MailRow({ msg }: { msg: MailMsg }): JSX.Element {
  const color = msg.type === 'completed' ? 'var(--green)'
    : msg.type === 'failed'    ? 'var(--red)'
    : msg.type === 'claimed'   ? 'var(--yellow)'
    : msg.type === 'started'   ? 'var(--blue)'
    : msg.type === 'stopped'   ? 'var(--muted)'
    : 'var(--muted)'
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        {new Date(msg.ts).toLocaleTimeString()}
      </span>
      <span style={{ color: 'var(--accent)', minWidth: 70, fontWeight: 600 }}>{msg.from}</span>
      <span style={{ color, minWidth: 65, fontWeight: 600 }}>{msg.type}</span>
      <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {msg.beadId ? `[${msg.beadId}] ` : ''}{msg.text ?? ''}
      </span>
    </div>
  )
}

function BeadTable({ beads }: { beads: BeadInfo[] }): JSX.Element {
  const [filter, setFilter] = useState<'all' | 'ready' | 'claimed' | 'done' | 'failed'>('all')
  const shown = filter === 'all' ? beads : beads.filter(b => b.status === filter)
  const counts: Record<string, number> = {}
  beads.forEach(b => { counts[b.status] = (counts[b.status] ?? 0) + 1 })

  return (
    <div>
      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {(['all', 'ready', 'claimed', 'done', 'failed'] as const).map(f => (
          <button key={f}
            className={`btn btn-ghost btn-sm${filter === f ? ' active' : ''}`}
            style={{ fontSize: 11, padding: '2px 8px', opacity: filter === f ? 1 : 0.6 }}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? `all (${beads.length})` : `${f} (${counts[f] ?? 0})`}
          </button>
        ))}
      </div>

      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        {shown.slice(0, 100).map(b => (
          <div key={b.id} style={{
            display: 'grid', gridTemplateColumns: '18px 60px 1fr 40px',
            gap: 8, alignItems: 'start', padding: '4px 0',
            borderBottom: '1px solid var(--border)', fontSize: 12
          }}>
            <span style={{ color: 'var(--muted)', marginTop: 1 }}>{TYPE_ICON[b.type] ?? '·'}</span>
            <span style={{
              color: STATUS_COLOR[b.status] ?? 'var(--muted)',
              fontWeight: 600, fontSize: 10, textTransform: 'uppercase', marginTop: 2
            }}>{b.status}</span>
            <div>
              <div style={{ color: 'var(--text)' }}>{b.title}</div>
              {b.claimedBy && <div style={{ fontSize: 10, color: 'var(--muted)' }}>→ {b.claimedBy}</div>}
            </div>
            <span style={{ color: 'var(--muted)', fontSize: 10, textAlign: 'right' }}>
              p{b.priority}
            </span>
          </div>
        ))}
        {shown.length > 100 && (
          <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 0' }}>
            …and {shown.length - 100} more
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props { projectPath: string }

export default function SwarmDashboard({ projectPath }: Props): JSX.Element {
  const [stats,      setStats]      = useState<SwarmStats | null>(null)
  const [agents,     setAgents]     = useState<AgentInfo[]>([])
  const [mail,       setMail]       = useState<MailMsg[]>([])
  const [graph,      setGraph]      = useState<BeadGraph | null>(null)
  const [running,    setRunning]    = useState(false)
  const [planning,   setPlanning]   = useState(false)
  const [planPhase,  setPlanPhase]  = useState('')
  const [workers,    setWorkers]    = useState(2)
  const [request,    setRequest]    = useState('')
  const [msg,        setMsg]        = useState<string | null>(null)
  const [activeTab,  setActiveTab]  = useState<'graph' | 'mail' | 'plan'>('graph')
  const mailEndRef = useRef<HTMLDivElement>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 4000) }

  // ── Load initial state ──────────────────────────────────────────────────

  const load = useCallback(async () => {
    const s = await window.ralph.swarm.status(projectPath) as {
      running: boolean; planning: boolean; workerCount: number
      agents: AgentInfo[]; stats: SwarmStats | null
    }
    setRunning(s.running)
    setPlanning(s.planning)
    setAgents(s.agents)
    setStats(s.stats)

    const g = await window.ralph.swarm.graph(projectPath) as BeadGraph | null
    setGraph(g)
    if (g) setStats(calcStats(g))

    const m = await window.ralph.swarm.mail(projectPath, 50) as MailMsg[]
    setMail(m)
  }, [projectPath])

  useEffect(() => { load() }, [load])

  // ── Push listeners ──────────────────────────────────────────────────────

  useEffect(() => {
    const unsubs = [
      window.ralph.swarm.onAgents((p, a) => {
        if (p !== projectPath) return
        setAgents(a as AgentInfo[])
      }),
      window.ralph.swarm.onGraph((p, s, g) => {
        if (p !== projectPath) return
        setStats(s as SwarmStats)
        setGraph(g as BeadGraph | null)
      }),
      window.ralph.swarm.onMail((p, m) => {
        if (p !== projectPath) return
        setMail(prev => [...prev, m as MailMsg].slice(-100))
        setTimeout(() => mailEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
      }),
      window.ralph.swarm.onPlanPhase((p, phase) => {
        if (p !== projectPath) return
        setPlanPhase(phase); setPlanning(true)
      }),
      window.ralph.swarm.onStopped((p) => {
        if (p !== projectPath) return
        setRunning(false); setPlanning(false); setAgents([])
      }),
    ]
    return () => unsubs.forEach(f => f())
  }, [projectPath])

  // ── Actions ─────────────────────────────────────────────────────────────

  const handleInject = async (): Promise<void> => {
    if (!request.trim()) return
    setPlanning(true)
    setPlanPhase('planning-1')
    const r = await window.ralph.swarm.inject(projectPath, request.trim())
    if (!r.ok) { flash(`Plan failed: ${r.error}`); setPlanning(false) }
    else setRequest('')
  }

  const handleStart = async (): Promise<void> => {
    const r = await window.ralph.swarm.start(projectPath, workers)
    if (r.ok) setRunning(true)
    else flash(`Failed: ${r.error}`)
  }

  const handleStop = async (): Promise<void> => {
    await window.ralph.swarm.stop(projectPath)
    setRunning(false); setPlanning(false)
    setAgents([]); flash('Swarm stopped')
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">⬡ Swarm</div>
          <div className="page-sub">Multi-agent parallel development loop</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Worker count */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            Workers:
            <select
              value={workers}
              onChange={e => setWorkers(Number(e.target.value))}
              style={{
                background: 'var(--surface2)', border: '1px solid var(--border)',
                color: 'var(--text)', borderRadius: 4, padding: '2px 6px', fontSize: 12
              }}
            >
              {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {running
            ? <button className="btn btn-sm" style={{ background: 'var(--red)', color: '#fff' }} onClick={handleStop}>■ Stop all</button>
            : <button className="btn btn-primary btn-sm" onClick={handleStart} disabled={planning}>
                ▶ Start workers
              </button>
          }
        </div>
      </div>

      {msg && (
        <div style={{ padding: '8px 24px', background: 'var(--surface2)', fontSize: 12, color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>
          {msg}
        </div>
      )}

      {/* Planning banner */}
      {planning && (
        <div style={{
          padding: '8px 24px', background: '#1c1a00', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12
        }}>
          <span className="spinner" style={{ width: 12, height: 12 }} />
          <span style={{ color: 'var(--yellow)' }}>
            {planPhase === 'encoding' ? 'Step 2 — Encoding plan to beads…'
              : planPhase === 'synthesizing' ? 'Step 1 — Synthesizing 3 plans…'
              : planPhase === 'done'  ? '✓ Plan & encode complete'
              : `Step 1 — Generating ${planPhase}…`}
          </span>
        </div>
      )}

      <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Top row: inject + stats + agents */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* Inject panel */}
          <div className="stat-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="stat-label">
              {planning ? '⟳ Planning in progress…' : 'Inject new tasks → Plan + Encode'}
            </div>
            <textarea
              value={request}
              onChange={e => setRequest(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void handleInject() } }}
              rows={5}
              disabled={planning}
              placeholder="Describe what you want built… (Ctrl+Enter to run Plan + Encode)"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text)', padding: '8px 10px',
                fontFamily: 'monospace', fontSize: 12, resize: 'vertical', outline: 'none'
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleInject()}
                disabled={planning || !request.trim()}
              >
                {planning ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '⬡'} Plan + Encode
              </button>
              <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>Ctrl+Enter</span>
            </div>
          </div>

          {/* Stats + agent cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Progress ring + stats */}
            {stats && (
              <div className="stat-card" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <ProgressRing pct={stats.pct} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 12 }}>
                    {[
                      ['total',   stats.total,   'var(--text)'],
                      ['ready',   stats.ready,   'var(--blue)'],
                      ['claimed', stats.claimed, 'var(--yellow)'],
                      ['done',    stats.done,    'var(--green)'],
                      ['pending', stats.pending, 'var(--muted)'],
                      ['failed',  stats.failed,  'var(--red)'],
                    ].map(([label, val, color]) => (
                      <div key={label as string}>
                        <span style={{ color: 'var(--muted)' }}>{label as string} </span>
                        <span style={{ color: color as string, fontWeight: 700 }}>{val as number}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Agent cards */}
            {agents.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>
                No workers running. Click "Start workers" to begin Steps 3–5.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {agents.map(a => <AgentCard key={a.id} agent={a} />)}
              </div>
            )}
          </div>
        </div>

        {/* Bottom panel: tabbed graph / mail / plan */}
        <div className="stat-card" style={{ flex: 1 }}>
          <div style={{ display: 'flex', gap: 1, marginBottom: 12, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
            {(['graph', 'mail', 'plan'] as const).map(tab => (
              <button key={tab}
                className={`btn btn-ghost btn-sm${activeTab === tab ? ' active' : ''}`}
                style={{ fontSize: 12, opacity: activeTab === tab ? 1 : 0.5 }}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'graph' ? `⬡ Beads (${graph?.beads.length ?? 0})`
                  : tab === 'mail' ? `✉ Agent mail (${mail.length})`
                  : '📋 Plan'}
              </button>
            ))}
          </div>

          {activeTab === 'graph' && (
            graph ? <BeadTable beads={graph.beads} />
            : <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                No bead graph yet. Inject tasks above to generate one.
              </div>
          )}

          {activeTab === 'mail' && (
            <div style={{ maxHeight: 320, overflowY: 'auto', fontFamily: 'monospace' }}>
              {mail.length === 0
                ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No messages yet</div>
                : mail.slice(-50).map((m, i) => <MailRow key={i} msg={m} />)
              }
              <div ref={mailEndRef} />
            </div>
          )}

          {activeTab === 'plan' && (
            <pre style={{
              fontSize: 12, color: 'var(--muted)', whiteSpace: 'pre-wrap',
              maxHeight: 400, overflowY: 'auto', lineHeight: 1.6
            }}>
              {graph?.planMd ?? 'No plan generated yet.'}
            </pre>
          )}
        </div>
      </div>
    </>
  )
}

// ── Util ───────────────────────────────────────────────────────────────────

function calcStats(graph: BeadGraph): SwarmStats {
  const c = { total: 0, pending: 0, ready: 0, claimed: 0, done: 0, failed: 0 }
  for (const b of graph.beads) {
    c.total++
    const s = b.status as keyof typeof c
    if (s in c) c[s]++
  }
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0
  return { ...c, pct }
}
