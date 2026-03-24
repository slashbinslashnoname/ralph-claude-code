import React, { useState, useEffect, useCallback } from 'react'
import type { SwarmStatus, ProgressStats, AgentInfo, CircuitBreakerSnapshot } from '../types/ipc'

const sb = window.slashbot

interface Props {
  projectPath: string
  circuit: CircuitBreakerSnapshot | null
  onNavigate: (page: string) => void
}

export default function Dashboard({ projectPath, circuit, onNavigate }: Props) {
  const [swarmStatus, setSwarmStatus] = useState<SwarmStatus | null>(null)
  const [beadStats, setBeadStats] = useState<ProgressStats | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [workerCount, setWorkerCount] = useState(2)

  // Sync local count from actual running count
  useEffect(() => {
    if (swarmStatus && swarmStatus.workerCount > 0) setWorkerCount(swarmStatus.workerCount)
  }, [swarmStatus?.workerCount])

  useEffect(() => {
    const load = async () => {
      const s = await sb.swarm.status(projectPath)
      setSwarmStatus(s)
      setAgents(s.agents ?? [])
      sb.beads.stats(projectPath).then(r => { if (r.ok) setBeadStats(r.stats ?? null) }).catch(() => {})
    }
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Live agent updates
  useEffect(() => {
    const unsub = sb.swarm.onAgents((_p: string, a: AgentInfo[]) => setAgents(a))
    return unsub
  }, [])

  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const isRunning = (swarmStatus?.workerCount ?? 0) > 0 || swarmStatus?.planning

  const startSwarm = useCallback(async () => {
    setStarting(true)
    try { await sb.swarm.start(projectPath, workerCount) } finally { setStarting(false) }
  }, [projectPath, workerCount])

  const stopSwarm = useCallback(async () => {
    setStopping(true)
    try { await sb.swarm.stop(projectPath) } finally { setStopping(false) }
  }, [projectPath])

  const pct = beadStats?.pct ?? 0

  return (
    <div className="page dashboard">
      <header className="page-header">
        <h2>Dashboard</h2>
        <div className="header-actions">
          <div className="worker-controls">
            {isRunning ? (
              <>
                <button className="btn btn-sm" disabled={workerCount <= 1}
                  onClick={() => { const n = workerCount - 1; setWorkerCount(n); sb.swarm.start(projectPath, n) }}>
                  {'\u2212'}
                </button>
                <span className="worker-count">{workerCount} agent{workerCount > 1 ? 's' : ''}</span>
                <button className="btn btn-sm btn-primary"
                  onClick={() => { const n = workerCount + 1; setWorkerCount(n); sb.swarm.start(projectPath, n) }}>
                  +
                </button>
                <button className="btn btn-danger" onClick={stopSwarm} disabled={stopping}>
                  {stopping ? 'Stopping\u2026' : 'Stop'}
                </button>
              </>
            ) : (
              <>
                <select className="select select-sm" value={workerCount}
                  onChange={e => setWorkerCount(Number(e.target.value))}>
                  {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} agent{n > 1 ? 's' : ''}</option>)}
                </select>
                <button className="btn btn-primary" onClick={startSwarm} disabled={starting}>
                  {starting ? 'Starting\u2026' : 'Start Swarm'}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="dashboard-grid">
        {/* Progress ring */}
        <div className="card card-hero">
          <div className="progress-ring-container">
            <svg viewBox="0 0 120 120" className="progress-ring">
              <circle cx="60" cy="60" r="52" className="progress-bg" />
              <circle cx="60" cy="60" r="52" className="progress-fill"
                style={{ strokeDasharray: `${pct * 3.27} 327` }} />
            </svg>
            <div className="progress-text">
              <span className="progress-pct">{pct}%</span>
              <span className="progress-label">Complete</span>
            </div>
          </div>
          <div className="hero-stats">
            <div className="stat"><span className="stat-value">{beadStats?.total ?? 0}</span><span className="stat-label">Total</span></div>
            <div className="stat"><span className="stat-value">{beadStats?.done ?? 0}</span><span className="stat-label">Done</span></div>
            <div className="stat"><span className="stat-value">{beadStats?.ready ?? 0}</span><span className="stat-label">Ready</span></div>
            <div className="stat"><span className="stat-value">{beadStats?.claimed ?? 0}</span><span className="stat-label">Active</span></div>
          </div>
        </div>

        {/* Swarm status */}
        <div className="card">
          <h3>Swarm Engine</h3>
          <div className="card-body">
            <div className="kv-row">
              <span>Status</span>
              <span className={`badge badge-${isRunning ? 'success' : 'idle'}`}>{isRunning ? 'Running' : 'Stopped'}</span>
            </div>
            <div className="kv-row">
              <span>Workers</span>
              <span>{swarmStatus?.workerCount ?? 0}</span>
            </div>
            <div className="kv-row">
              <span>Planning</span>
              <span className={`badge badge-${swarmStatus?.planning ? 'warning' : 'idle'}`}>
                {swarmStatus?.planning ? 'Active' : 'Idle'}
              </span>
            </div>
            {agents.length > 0 && (
              <div className="agent-mini-list">
                {agents.map(a => (
                  <div key={a.id} className="kv-row">
                    <span className="agent-mini">
                      <span className={`agent-dot ${a.phase}`} />
                      {a.id}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`badge badge-${a.phase === 'paused' ? 'warning' : 'info'}`}>{a.phase}</span>
                      {a.phase === 'paused' ? (
                        <button className="btn btn-xs btn-accent" onClick={() => sb.swarm.resumeAgent(projectPath, a.id)}
                          title="Resume">Resume</button>
                      ) : (
                        <button className="btn btn-xs btn-outline" onClick={() => sb.swarm.pauseAgent(projectPath, a.id)}
                          title="Pause">Pause</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!isRunning && (beadStats?.ready ?? 0) > 0 && (
              <p className="hint mt-2">{beadStats?.ready} bead{(beadStats?.ready ?? 0) > 1 ? 's' : ''} ready — start the swarm to begin work</p>
            )}
            {!isRunning && (beadStats?.total ?? 0) === 0 && (
              <p className="hint mt-2">
                No beads yet —{' '}
                <button className="btn-link" onClick={() => onNavigate('swarm')}>inject a plan</button>{' '}
                or{' '}
                <button className="btn-link" onClick={() => onNavigate('beads')}>create beads</button>
              </p>
            )}
          </div>
        </div>

        {/* Circuit breaker */}
        <div className="card">
          <h3>Circuit Breaker</h3>
          <div className="card-body">
            <div className="kv-row">
              <span>State</span>
              <span className={`badge badge-${(circuit?.state ?? 'CLOSED').toLowerCase()}`}>
                {circuit?.state ?? 'CLOSED'}
              </span>
            </div>
            <div className="kv-row">
              <span>No-Progress</span>
              <span>{circuit?.consecutive_no_progress ?? 0}</span>
            </div>
            <div className="kv-row">
              <span>Same-Error</span>
              <span>{circuit?.consecutive_same_error ?? 0}</span>
            </div>
            {circuit?.state === 'OPEN' && (
              <button className="btn btn-sm btn-warning mt-2"
                onClick={() => sb.resetCircuit(projectPath)}>
                Reset Circuit
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
