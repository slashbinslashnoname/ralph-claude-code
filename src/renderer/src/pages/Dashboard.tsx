import React, { useState, useEffect, useCallback } from 'react'
import type { SwarmStatus, SwarmPhase, ProgressStats, AgentInfo, CircuitBreakerSnapshot } from '../types/ipc'

const sb = window.slashbot

interface Props {
  projectPath: string
  circuits: Record<string, CircuitBreakerSnapshot>
  onNavigate: (page: string) => void
}

function circuitSuggestion(cb: CircuitBreakerSnapshot): string {
  if (cb.rate_limit_until) return 'API rate limit hit. Wait for the limit to reset or reduce worker count.'
  if (cb.consecutive_no_progress > 0) return 'Agent made no progress over multiple loops. Check if the task is too complex or the bead needs splitting.'
  if (cb.consecutive_same_error > 0) return 'Agent hit the same error repeatedly. Check logs for the recurring error and fix the underlying issue.'
  if (cb.consecutive_permission_denials > 0) return 'Agent was denied permissions repeatedly. Check Claude Code permission settings.'
  if (cb.error_window_count > 0) return 'Too many errors in a short window. Check logs for details and reset when the issue is resolved.'
  return 'Circuit tripped due to repeated failures. Check logs and reset when ready.'
}

export default function Dashboard({ projectPath, circuits, onNavigate }: Props) {
  const [swarmStatus, setSwarmStatus] = useState<SwarmStatus | null>(null)
  const [beadStats, setBeadStats] = useState<ProgressStats | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [workerCount, setWorkerCount] = useState(2)
  const [circuitsExpanded, setCircuitsExpanded] = useState(false)
  const [swarmPhase, setSwarmPhase] = useState<SwarmPhase>('idle')
  const [stopElapsed, setStopElapsed] = useState(0)

  // Sync local count from actual running count
  useEffect(() => {
    if (swarmStatus && swarmStatus.workerCount > 0) setWorkerCount(swarmStatus.workerCount)
  }, [swarmStatus?.workerCount])

  useEffect(() => {
    const load = async () => {
      const s = await sb.swarm.status(projectPath)
      setSwarmStatus(s)
      setAgents(s.agents ?? [])
      if (s.swarmPhase) setSwarmPhase(s.swarmPhase)
      sb.beads.stats(projectPath).then(r => { if (r.ok) setBeadStats(r.stats ?? null) }).catch(() => {})
    }
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Live agent + phase updates
  useEffect(() => {
    const unsubs = [
      sb.swarm.onAgents((_p: string, a: AgentInfo[]) => setAgents(a)),
      sb.swarm.onSwarmPhase((_p: string, phase: SwarmPhase) => setSwarmPhase(phase)),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  const isRunning = (swarmStatus?.workerCount ?? 0) > 0 || swarmStatus?.planning
  const isStartingPhase = swarmPhase === 'starting' || swarmPhase === 'health-check' || swarmPhase === 'spawning-workers'
  const isStoppingPhase = swarmPhase === 'stopping'

  // Track stop elapsed time for force-stop timeout
  useEffect(() => {
    if (swarmPhase === 'stopping') {
      setStopElapsed(0)
      const timer = setInterval(() => setStopElapsed(prev => Math.min(prev + 1, 30)), 1000)
      return () => clearInterval(timer)
    } else {
      setStopElapsed(0)
    }
  }, [swarmPhase])

  // Auto-force-stop after 30s
  useEffect(() => {
    if (swarmPhase === 'stopping' && stopElapsed >= 30) {
      sb.swarm.stop(projectPath).catch(() => {})
    }
  }, [swarmPhase, stopElapsed, projectPath])

  const startSwarm = useCallback(async () => {
    try { await sb.swarm.start(projectPath, workerCount) } catch { /* handled by phase */ }
  }, [projectPath, workerCount])

  const stopSwarm = useCallback(async () => {
    try { await sb.swarm.stop(projectPath) } catch { /* handled by phase */ }
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
                <button className="btn btn-sm" disabled={workerCount <= 1 || isStoppingPhase}
                  onClick={() => { const n = workerCount - 1; setWorkerCount(n); sb.swarm.start(projectPath, n) }}>
                  {'\u2212'}
                </button>
                <span className="worker-count">{workerCount} agent{workerCount > 1 ? 's' : ''}</span>
                <button className="btn btn-sm btn-primary" disabled={isStoppingPhase}
                  onClick={() => { const n = workerCount + 1; setWorkerCount(n); sb.swarm.start(projectPath, n) }}>
                  +
                </button>
                <button className="btn btn-danger" onClick={stopSwarm} disabled={isStoppingPhase}>
                  {isStoppingPhase ? `Stopping\u2026 (${30 - stopElapsed}s)` : 'Stop'}
                </button>
              </>
            ) : (
              <>
                <select className="select select-sm" value={workerCount}
                  onChange={e => setWorkerCount(Number(e.target.value))}>
                  {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} agent{n > 1 ? 's' : ''}</option>)}
                </select>
                <button className="btn btn-primary" onClick={startSwarm} disabled={isStartingPhase}>
                  {isStartingPhase ? 'Starting\u2026' : 'Start Swarm'}
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
              <span className={`badge badge-${isRunning ? 'success' : isStartingPhase ? 'warning' : 'idle'}`}>
                {isStartingPhase ? 'Starting' : isStoppingPhase ? 'Stopping' : isRunning ? 'Running' : 'Stopped'}
              </span>
            </div>
            {isStartingPhase && (
              <div className="swarm-phase-card" data-testid="dashboard-phase-card">
                <div className="swarm-phase-steps">
                  {(['starting', 'health-check', 'spawning-workers'] as const).map((step, i) => {
                    const stepLabels = { 'starting': 'Initialize', 'health-check': 'Health Check', 'spawning-workers': 'Spawn Workers' }
                    const phases: SwarmPhase[] = ['starting', 'health-check', 'spawning-workers']
                    const currentIdx = phases.indexOf(swarmPhase)
                    const isDone = i < currentIdx
                    const isCurrent = i === currentIdx
                    return (
                      <span key={step} className={`swarm-phase-step ${isDone ? 'done' : isCurrent ? 'active' : 'pending'}`}>
                        <span className="swarm-phase-dot" />
                        {stepLabels[step]}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
            {isStoppingPhase && (
              <div className="swarm-phase-card swarm-phase-stopping" data-testid="dashboard-stop-card">
                <span>Stopping\u2026 ({30 - stopElapsed}s until force stop)</span>
                {stopElapsed >= 10 && (
                  <button className="btn btn-xs btn-danger" onClick={stopSwarm}>Force stop</button>
                )}
              </div>
            )}
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

        {/* Circuit breaker — per-worker */}
        <div className="card">
          <h3>
            Circuit Breakers
            {(() => {
              const states = Object.values(circuits).map(c => c.state)
              if (states.includes('OPEN')) return <span className="pill pill-red" data-testid="circuit-warning-pill">OPEN</span>
              if (states.includes('HALF_OPEN')) return <span className="pill pill-amber" data-testid="circuit-warning-pill">HALF_OPEN</span>
              return null
            })()}
          </h3>
          <div className="card-body">
            {(() => {
              const entries = Object.entries(circuits)
              if (entries.length === 0) {
                return <p className="hint">No circuit breaker data yet</p>
              }
              const collapsed = !circuitsExpanded && entries.length > 3
              const visible = collapsed ? entries.slice(0, 3) : entries
              return (
                <>
                  {visible.map(([agentId, cb]) => (
                    <div key={agentId} className="circuit-row">
                      <div className="kv-row">
                        <span className="agent-mini">{agentId}</span>
                        <span className={`badge badge-${cb.state.toLowerCase()}`}>{cb.state}</span>
                      </div>
                      <div className="circuit-details">
                        <span>Errors: {cb.error_window_count ?? 0}</span>
                        {cb.reopen_epoch > 0 && <span>Reopen: {cb.reopen_epoch}</span>}
                        {cb.rate_limit_until && <span>Rate-limit: {cb.rate_limit_until}</span>}
                      </div>
                      {cb.state === 'OPEN' && (
                        <div className="circuit-recovery">
                          {cb.reason && (
                            <p className="circuit-reason" data-testid="circuit-reason">
                              <strong>Reason:</strong> {cb.reason}
                            </p>
                          )}
                          <div className="circuit-context" data-testid="circuit-context">
                            {cb.opened_at && (
                              <span className="circuit-context-item">
                                Opened {(() => {
                                  const diff = Date.now() - new Date(cb.opened_at).getTime()
                                  if (diff < 60_000) return 'just now'
                                  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
                                  return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m ago`
                                })()}
                              </span>
                            )}
                            {cb.total_opens > 1 && (
                              <span className="circuit-context-item" data-testid="circuit-total-opens">
                                Tripped {cb.total_opens} times
                              </span>
                            )}
                            {cb.reopen_epoch > 0 && (
                              <span className="circuit-context-item">
                                Cooldown epoch {cb.reopen_epoch}
                              </span>
                            )}
                          </div>
                          <p className="circuit-suggestion" data-testid="circuit-suggestion">
                            {circuitSuggestion(cb)}
                          </p>
                          <div className="circuit-actions">
                            <button className="btn btn-xs btn-warning"
                              onClick={() => sb.resetCircuit(projectPath, agentId)}>
                              Reset
                            </button>
                            <button className="btn btn-xs btn-ghost"
                              onClick={() => onNavigate('logs')}>
                              View Logs
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {entries.length > 3 && (
                    <button className="btn btn-xs btn-ghost mt-1"
                      onClick={() => setCircuitsExpanded(e => !e)}>
                      {circuitsExpanded ? 'Show less' : `Show ${entries.length - 3} more`}
                    </button>
                  )}
                </>
              )
            })()}
          </div>
        </div>

      </div>
    </div>
  )
}
