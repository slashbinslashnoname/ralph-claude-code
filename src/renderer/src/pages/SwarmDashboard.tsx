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

import React, { useCallback, useEffect, useState } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────

interface SwarmStats {
  total: number; pending: number; ready: number
  claimed: number; done: number; failed: number; pct: number
}

interface AgentInfo {
  id: string; index: number; phase: string
  currentBeadId: string | null; loopCount: number; lastActivity: string
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

// ── Main component ─────────────────────────────────────────────────────────

interface Props { projectPath: string }

export default function SwarmDashboard({ projectPath }: Props): JSX.Element {
  const [stats,     setStats]     = useState<SwarmStats | null>(null)
  const [agents,    setAgents]    = useState<AgentInfo[]>([])
  const [running,   setRunning]   = useState(false)
  const [planning,  setPlanning]  = useState(false)
  const [planPhase, setPlanPhase] = useState('')
  const [workers,   setWorkers]   = useState(2)
  const [msg,       setMsg]       = useState<string | null>(null)

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
  }, [projectPath])

  useEffect(() => { load() }, [load])

  // ── Push listeners ──────────────────────────────────────────────────────

  useEffect(() => {
    const unsubs = [
      window.ralph.swarm.onAgents((p, a) => {
        if (p !== projectPath) return
        setAgents(a as AgentInfo[])
      }),
      window.ralph.swarm.onGraph((p, s) => {
        if (p !== projectPath) return
        setStats(s as SwarmStats)
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
            No workers running. Click "Start workers" to begin.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {agents.map(a => <AgentCard key={a.id} agent={a} />)}
          </div>
        )}
      </div>
    </>
  )
}

