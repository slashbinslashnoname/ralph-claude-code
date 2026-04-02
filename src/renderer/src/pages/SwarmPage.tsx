import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { globalAgentOutputs } from '../App'
import AgentOutputRenderer from '../components/AgentOutputRenderer'
import type { SwarmStatus, AgentInfo, ActivityEvent, ProgressStats, KnowledgeEntry } from '../types/ipc'

export function knowledgeCategoryColor(cat: string): string {
  switch (cat) {
    case 'gotcha': case 'risk': return 'danger'
    case 'pattern': case 'convention': return 'accent'
    case 'dependency': return 'warning'
    case 'environment': return 'info'
    default: return 'info'
  }
}

const sb = window.slashbot

export interface BuildMonitorStatus {
  enabled: boolean
  running: boolean
  lastStatus?: 'passed' | 'failed'
}

export function BuildMonitorIndicator({
  status,
  onToggle,
}: {
  status: BuildMonitorStatus
  onToggle: (enabled: boolean) => void
}) {
  const dotClass = !status.enabled
    ? 'gray'
    : status.lastStatus === 'passed'
      ? 'green'
      : status.lastStatus === 'failed'
        ? 'red'
        : 'gray'

  const tooltip = !status.enabled
    ? 'Build monitor: off\nClick to enable'
    : status.running
      ? `Build monitor: ${status.lastStatus ?? 'waiting'}\nClick to disable`
      : 'Build monitor: enabled (not running)\nClick to disable'

  return (
    <span
      className={`stat-chip build-monitor-status ${status.enabled ? 'enabled' : 'disabled'}`}
      title={tooltip}
      onClick={() => onToggle(!status.enabled)}
      style={{ cursor: 'pointer' }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4, verticalAlign: 'middle' }}>
        <path d="M22 2H2v20h20V2zm-2 18H4V4h16v16zM6 6h4v4H6V6zm0 6h4v4H6v-4zm6-6h4v4h-4V6zm6 0h2v4h-2V6zm-6 6h4v4h-4v-4zm6 0h2v4h-2v-4z"/>
      </svg>
      <span className={`build-dot ${dotClass}`} />
    </span>
  )
}

export interface TelegramStatus {
  connected: boolean
  botUsername: string | null
  lastError: string | null
  messagesSent: number
  messagesReceived: number
}

export function TelegramStatusIndicator({ status }: { status: TelegramStatus }) {
  return (
    <span
      className={`stat-chip telegram-status ${status.connected ? 'connected' : 'disconnected'}`}
      title={status.connected
        ? `Telegram: @${status.botUsername ?? 'unknown'}\nSent: ${status.messagesSent} | Received: ${status.messagesReceived}`
        : `Telegram: disconnected${status.lastError ? `\n${status.lastError}` : ''}`
      }
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4, verticalAlign: 'middle' }}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.74 3.99-1.74 6.65-2.89 7.99-3.44 3.8-1.58 4.59-1.86 5.1-1.87.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .38z"/>
      </svg>
      <span className={`telegram-dot ${status.connected ? 'green' : 'red'}`} />
    </span>
  )
}

interface Props {
  projectPath: string
  agentOutputs: Record<string, string>
  setAgentOutputs: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activity: ActivityEvent[]
  setActivity: React.Dispatch<React.SetStateAction<ActivityEvent[]>>
}

export default function SwarmPage({ projectPath, agentOutputs, setAgentOutputs, activity, setActivity }: Props) {
  const [swarmStatus, setSwarmStatus] = useState<SwarmStatus | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [stats, setStats] = useState<ProgressStats | null>(null)
  const [planPhase, setPlanPhase] = useState('')
  const [workerCount, setWorkerCount] = useState(2)
  // Sync local count from actual running count
  useEffect(() => {
    if (swarmStatus && swarmStatus.workerCount > 0) setWorkerCount(swarmStatus.workerCount)
  }, [swarmStatus?.workerCount])
  const [activeTab, setActiveTab] = useState<string>('overview')
  const outputRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const activityRef = useRef<HTMLDivElement | null>(null)
  const [historyLogs, setHistoryLogs] = useState<{ file: string; agentId: string; phase: string; timestamp: string; size: number }[]>([])
  const [historyContent, setHistoryContent] = useState<string | null>(null)
  const [historyFile, setHistoryFile] = useState<string | null>(null)
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null)
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([])
  const [buildMonitor, setBuildMonitor] = useState<BuildMonitorStatus>({ enabled: false, running: false })

  // Initial load + polling (status/agents/stats only — not activity)
  useEffect(() => {
    const load = async () => {
      const s = await sb.swarm.status(projectPath)
      setSwarmStatus(s)
      setAgents(s.agents ?? [])
      if (s.stats) setStats(s.stats)
      await sb.swarm.queue(projectPath)
    }
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Poll Telegram status every 5s
  useEffect(() => {
    const poll = () => sb.telegram.status(projectPath).then(setTelegramStatus).catch(() => {})
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Load full activity history once on mount (if not already loaded by App)
  useEffect(() => {
    if (activity.length === 0) {
      sb.swarm.activity(projectPath, 200).then(setActivity)
    }
  }, [projectPath])

  // Poll build monitor status
  useEffect(() => {
    const poll = () =>
      sb.swarm.buildMonitor.status(projectPath)
        .then((s: { enabled: boolean; running: boolean; error?: string }) => {
          if (s && !s.error) setBuildMonitor(prev => ({ ...prev, enabled: s.enabled, running: s.running }))
        })
        .catch(() => {})
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Live build status events
  useEffect(() => {
    const unsub = sb.swarm.onBuildStatus((_p: string, status: string, detail?: { beadCreated?: boolean; beadId?: string; beadTitle?: string }) => {
      setBuildMonitor(prev => ({ ...prev, lastStatus: status as 'passed' | 'failed' }))
      // When a fix bead is auto-created, inject into activity feed
      if (detail?.beadCreated) {
        setActivity(prev => [{
          ts: new Date().toISOString(),
          agentId: 'build-monitor',
          type: 'started',
          beadId: detail.beadId ?? '',
          summary: `Auto-created fix bead: ${detail.beadTitle ?? detail.beadId ?? 'build fix'}`,
        }, ...prev])
      }
    })
    return () => unsub()
  }, [setActivity])

  // Poll knowledge entries
  useEffect(() => {
    const load = () => sb.swarm.knowledge(projectPath, 100).then(setKnowledge).catch(() => {})
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Live events (agents, stats, plan — output & activity handled by App)
  useEffect(() => {
    const unsubs = [
      sb.swarm.onAgents((_p: string, a: AgentInfo[]) => setAgents(a)),
      sb.swarm.onGraph((_p: string, s: ProgressStats) => setStats(s)),
      sb.swarm.onPlanPhase((_p: string, phase: string) => setPlanPhase(phase)),
      sb.swarm.onPlanQueue(() => {}),
    ]
    return () => unsubs.forEach(u => u())
  }, [])

  // Auto-scroll agent outputs
  useEffect(() => {
    const el = outputRefs.current[activeTab]
    if (el) el.scrollTop = el.scrollHeight
  }, [agentOutputs, activeTab])

  // Auto-scroll activity feed
  useEffect(() => {
    if (activeTab === 'activity' && activityRef.current) {
      activityRef.current.scrollTop = 0 // newest on top
    }
  }, [activity, activeTab])

  // Fetch full historical output when switching to an agent tab
  const fetchedTabs = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (activeTab === 'overview' || activeTab === 'activity' || activeTab === 'history') return
    if (fetchedTabs.current.has(activeTab)) return
    fetchedTabs.current.add(activeTab)
    sb.swarm.agentOutput(projectPath, activeTab).then(output => {
      if (output) {
        // Disk log is authoritative — replace whatever live buffer had
        // Also update the global buffer so live chunks append correctly from here
        globalAgentOutputs[activeTab] = output
        setAgentOutputs(prev => ({ ...prev, [activeTab]: output }))
      }
    })
  }, [activeTab, projectPath])

  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)

  const startSwarm = useCallback(async () => {
    setStarting(true)
    try { await sb.swarm.start(projectPath, workerCount) } finally { setStarting(false) }
  }, [projectPath, workerCount])

  const stopSwarm = useCallback(async () => {
    setStopping(true)
    try { await sb.swarm.stop(projectPath) } finally { setStopping(false) }
  }, [projectPath])

  const gracefulStopSwarm = useCallback(async () => {
    setStopping(true)
    try { await sb.swarm.gracefulStop(projectPath) } finally { setStopping(false) }
  }, [projectPath])

  const pauseAgent = useCallback(async (agentId: string) => {
    await sb.swarm.pauseAgent(projectPath, agentId)
  }, [projectPath])

  const resumeAgent = useCallback(async (agentId: string) => {
    await sb.swarm.resumeAgent(projectPath, agentId)
  }, [projectPath])

  const pauseAllAgents = useCallback(async () => {
    await sb.swarm.pauseAll(projectPath)
  }, [projectPath])

  const resumeAllAgents = useCallback(async () => {
    await sb.swarm.resumeAll(projectPath)
  }, [projectPath])

  const toggleBuildMonitor = useCallback(async (enabled: boolean) => {
    const result = await sb.swarm.buildMonitor.toggle(projectPath, enabled)
    if (result && !result.error) {
      setBuildMonitor(prev => ({ ...prev, enabled: result.enabled, running: result.running }))
    }
  }, [projectPath])

  const allPaused = agents.length > 0 && agents.every(a => a.phase === 'paused')
  const anyPaused = agents.some(a => a.phase === 'paused')

  const isRunning = (swarmStatus?.workerCount ?? 0) > 0 || swarmStatus?.planning
  const isPlanning = swarmStatus?.planning ?? false

  const phaseColor = (phase: string) => {
    if (phase === 'thinking') return 'accent'
    if (phase === 'executing') return 'success'
    if (phase === 'reviewing') return 'warning'
    if (phase === 'merging') return 'info'
    if (phase === 'routing' || phase === 'claiming') return 'info'
    if (phase === 'paused') return 'warning'
    if (phase === 'rate_limited') return 'danger'
    return 'idle'
  }

  type FeedItem =
    | { kind: 'activity'; ts: string; data: ActivityEvent }
    | { kind: 'knowledge'; ts: string; data: KnowledgeEntry }

  const mergedFeed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...activity.map(e => ({ kind: 'activity' as const, ts: e.ts, data: e })),
      ...knowledge.map(k => ({ kind: 'knowledge' as const, ts: k.ts, data: k })),
    ]
    items.sort((a, b) => b.ts.localeCompare(a.ts)) // newest first
    return items.slice(0, 200)
  }, [activity, knowledge])

  const activityIcon = (type: string) => {
    switch (type) {
      case 'thinking': return '\u{1F9E0}'
      case 'claimed': return '\u{1F4CB}'
      case 'executing': return '\u26A1'
      case 'merged': return '\u{1F500}'
      case 'completed': return '\u2713'
      case 'failed': return '\u2717'
      case 'started': return '\u25B6'
      case 'stopped': return '\u25A0'
      case 'paused': return '\u23F8'
      case 'resumed': return '\u25B6'
      case 'circuit_open': return '\u{1F534}'
      case 'circuit_closed': return '\u{1F7E2}'
      case 'bead-created': return '\u{1F527}'
      default: return '\u2022'
    }
  }

  return (
    <div className="page swarm-page">
      <header className="page-header">
        <h2>Swarm</h2>
        <div className="header-actions">
          <BuildMonitorIndicator status={buildMonitor} onToggle={toggleBuildMonitor} />
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
                {allPaused ? (
                  <button className="btn btn-accent" onClick={resumeAllAgents}
                    title="Resume all paused agents">
                    Resume All
                  </button>
                ) : (
                  <button className="btn btn-outline" onClick={pauseAllAgents}
                    title="Pause all agents after current phase">
                    {anyPaused ? 'Pause Rest' : 'Pause All'}
                  </button>
                )}
                <button className="btn btn-warning" onClick={gracefulStopSwarm}
                  disabled={swarmStatus?.stoppingGracefully}
                  title="Finish current beads then stop">
                  {swarmStatus?.stoppingGracefully ? 'Stopping…' : 'Stop after bead'}
                </button>
                <button className="btn btn-danger" onClick={stopSwarm} disabled={stopping}>
                  {stopping ? 'Stopping\u2026' : 'Stop now'}
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

      {/* Stats bar */}
      {stats && stats.total > 0 && (
        <div className="stats-bar">
          <div className="stats-progress">
            <div className="stats-fill" style={{ width: `${stats.pct}%` }} />
          </div>
          <div className="stats-numbers">
            <span className="stat-chip done">{stats.done} done</span>
            <span className="stat-chip claimed">{stats.claimed} active</span>
            <span className="stat-chip ready">{stats.ready} ready</span>
            <span className="stat-chip pending">{stats.pending} pending</span>
            <span className="stat-chip failed">{stats.failed} failed</span>
            {telegramStatus && <TelegramStatusIndicator status={telegramStatus} />}
          </div>
        </div>
      )}

      {/* Graceful stop banner */}
      {swarmStatus?.stoppingGracefully && (
        <div className="graceful-stop-banner">
          Agents will stop after finishing their current bead.
          <button className="btn btn-sm btn-danger" style={{ marginLeft: 12 }} onClick={stopSwarm}>Force stop now</button>
        </div>
      )}

      {/* Agent tabs */}
      <nav className="swarm-tabs">
        <div className="swarm-tabs-nav">
          <button className={`swarm-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button className={`swarm-tab ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}>
            Activity
            {mergedFeed.length > 0 && <span className="swarm-tab-count">{mergedFeed.length}</span>}
          </button>
          <button className={`swarm-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('history')
              sb.swarm.agentLogs(projectPath).then(logs => {
                const sessionStart = swarmStatus?.sessionStartedAt
                if (sessionStart) {
                  const startTs = sessionStart.replace(/[:.]/g, '-').slice(0, 19)
                  setHistoryLogs(logs.filter(l => l.file >= `worker-0_a_${startTs}`))
                } else {
                  setHistoryLogs(logs)
                }
              })
            }}>
            History
          </button>
        </div>
        {(agents.length > 0 || isPlanning || agentOutputs['planner']) && (
          <div className="swarm-tabs-agents">
            {agents.map(a => (
              <button key={a.id} className={`swarm-tab swarm-tab-agent ${activeTab === a.id ? 'active' : ''}`}
                onClick={() => setActiveTab(a.id)}>
                <span className={`agent-dot ${a.phase}`} />
                <span className="swarm-tab-agent-name">{a.id}</span>
                {a.currentBeadId && <span className="swarm-tab-bead">{a.currentBeadId}</span>}
              </button>
            ))}
            {(isPlanning || agentOutputs['planner']) && (
              <button className={`swarm-tab swarm-tab-agent ${activeTab === 'planner' ? 'active' : ''}`}
                onClick={() => setActiveTab('planner')}>
                <span className={`agent-dot ${isPlanning ? 'executing' : 'idle'}`} />
                <span className="swarm-tab-agent-name">planner</span>
              </button>
            )}
          </div>
        )}
      </nav>

      <div className="swarm-content">
        {activeTab === 'overview' && (
          <>
            {agents.length === 0 ? (
              <div className="empty-state-sm">
                <p>No agents running. Start the swarm to begin.</p>
              </div>
            ) : (
              <div className="overview-list">
                {agents.map(a => (
                  <div key={a.id} className={`worker-panel worker-panel-${phaseColor(a.phase)}`}>
                    <div className="worker-panel-header" onClick={() => setActiveTab(a.id)}>
                      <div className="worker-panel-identity">
                        <span className={`agent-dot agent-dot-lg ${a.phase}`} />
                        <strong className="worker-panel-name">{a.id}</strong>
                        <span className={`badge badge-${phaseColor(a.phase)}`}>
                          {a.phase}
                        </span>
                      </div>
                      <div className="worker-panel-meta">
                        {a.currentBeadId && (
                          <span className="worker-panel-bead">
                            <span className="worker-panel-bead-id">{a.currentBeadId}</span>
                            {a.currentBeadTitle && <span className="worker-panel-bead-title">{a.currentBeadTitle}</span>}
                          </span>
                        )}
                        {a.worktreeBranch && (
                          <span className="worker-panel-branch">{a.worktreeBranch}</span>
                        )}
                        <span className="worker-panel-loops">Loop #{a.loopCount}</span>
                        {a.phase === 'paused' ? (
                          <button className="btn btn-xs btn-accent" onClick={e => { e.stopPropagation(); resumeAgent(a.id) }}>
                            Resume
                          </button>
                        ) : (
                          <button className="btn btn-xs btn-outline" onClick={e => { e.stopPropagation(); pauseAgent(a.id) }}>
                            Pause
                          </button>
                        )}
                      </div>
                    </div>
                    {a.thinkingSummary && a.phase === 'thinking' && (
                      <div className="agent-thinking">
                        <span className="thinking-label">Thinking:</span>
                        <p>{a.thinkingSummary.slice(0, 300)}</p>
                      </div>
                    )}
                    {/* Live output preview */}
                    <div className="worker-panel-output" onClick={() => setActiveTab(a.id)}>
                      {agentOutputs[a.id]
                        ? <AgentOutputRenderer output={agentOutputs[a.id]} />
                        : <span className="cr-waiting">Waiting for output\u2026</span>
                      }
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'activity' && (
          <div className="activity-list" ref={activityRef}>
            {mergedFeed.map((item, i) => {
              if (item.kind === 'knowledge') {
                const k = item.data as KnowledgeEntry
                return (
                  <div key={`k-${k.ts}-${k.agentId}-${i}`} className="activity-item activity-knowledge">
                    <span className="activity-icon" title="Knowledge">{'\uD83D\uDCA1'}</span>
                    <span className="activity-time">{new Date(k.ts).toLocaleTimeString()}</span>
                    <span className="activity-agent">{k.agentId}</span>
                    <span className={`badge badge-${knowledgeCategoryColor(k.category)}`}>
                      {k.category}
                    </span>
                    {k.beadId && <span className="activity-bead">{k.beadId}</span>}
                    <span className="activity-summary">{k.summary}</span>
                    {k.confidence !== 'high' && (
                      <span className="activity-confidence">{k.confidence}</span>
                    )}
                  </div>
                )
              }
              const e = item.data as ActivityEvent
              return (
                <div key={`a-${e.ts}-${e.agentId}-${i}`} className={`activity-item activity-${e.type}`}>
                  <span className="activity-icon">{activityIcon(e.type)}</span>
                  <span className="activity-time">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="activity-agent">{e.agentId}</span>
                  <span className={`badge badge-${e.type === 'completed' || e.type === 'merged' ? 'success' : e.type === 'failed' ? 'danger' : e.type === 'thinking' ? 'accent' : 'info'}`}>
                    {e.type}
                  </span>
                  {e.beadId && <span className="activity-bead">{e.beadId}</span>}
                  {e.summary && <span className="activity-summary">{e.summary}</span>}
                  {e.filesChanged && e.filesChanged.length > 0 && (
                    <span className="activity-files">{e.filesChanged.length} files</span>
                  )}
                  {e.branch && <span className="activity-branch">{e.branch}</span>}
                </div>
              )
            })}
            {mergedFeed.length === 0 && (
              <div className="empty-state-sm">
                <p>No activity yet. Start the swarm to see agent work here.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div>
            {historyContent && historyFile ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <button className="btn btn-xs btn-ghost" onClick={() => { setHistoryContent(null); setHistoryFile(null) }}>
                    {'\u2190'} Back
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{historyFile}</span>
                </div>
                <div className="agent-output">
                  <AgentOutputRenderer output={historyContent} />
                </div>
              </div>
            ) : (
              <div className="activity-list">
                {historyLogs.length === 0 && (
                  <div className="empty-state-sm"><p>No agent logs yet.</p></div>
                )}
                {historyLogs.map(log => (
                  <div key={log.file} className="activity-item" style={{ cursor: 'pointer' }}
                    onClick={() => {
                      setHistoryFile(log.file)
                      sb.swarm.agentLogContent(projectPath, log.file).then(setHistoryContent)
                    }}>
                    <span className={`agent-dot ${log.phase === 'execute' ? 'executing' : log.phase === 'think' ? 'thinking' : 'reviewing'}`} />
                    <span className="activity-agent">{log.agentId}</span>
                    <span className={`badge badge-${log.phase === 'execute' ? 'success' : log.phase === 'think' ? 'accent' : 'warning'}`}>
                      {log.phase}
                    </span>
                    <span className="activity-summary">{log.timestamp}</span>
                    <span className="activity-files">{(log.size / 1024).toFixed(0)}KB</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Per-agent live output */}
        {(agents.some(a => a.id === activeTab) || activeTab === 'planner') && (
          <div className="agent-output agent-output-live" ref={el => { outputRefs.current[activeTab] = el }}>
            {agentOutputs[activeTab]
              ? <AgentOutputRenderer output={agentOutputs[activeTab]} />
              : <span className="cr-waiting">Waiting for output...</span>
            }
          </div>
        )}
      </div>
    </div>
  )
}
