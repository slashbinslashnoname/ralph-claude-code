import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { globalAgentOutputs } from '../App'

const ralph = window.ralph

interface Props {
  projectPath: string
  agentOutputs: Record<string, string>
  setAgentOutputs: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activity: any[]
  setActivity: React.Dispatch<React.SetStateAction<any[]>>
}

// ── Claude result JSON parser & renderer ────────────────────────────────────

interface ClaudeResult {
  type: 'result'
  subtype: string
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  result: string
  stop_reason: string
  session_id: string
  total_cost_usd: number
  usage: any
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
  }>
}

type OutputSegment =
  | { kind: 'text'; text: string }
  | { kind: 'result'; data: ClaudeResult }

/** Find the end of a JSON object starting at `start`, handling strings correctly */
function findJsonEnd(raw: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return -1 // incomplete
}

function parseOutputSegments(raw: string): OutputSegment[] {
  const segments: OutputSegment[] = []
  const marker = '{"type":"result"'
  let pos = 0

  while (pos < raw.length) {
    const idx = raw.indexOf(marker, pos)
    if (idx < 0) {
      segments.push({ kind: 'text', text: raw.slice(pos) })
      break
    }

    if (idx > pos) {
      segments.push({ kind: 'text', text: raw.slice(pos, idx) })
    }

    const end = findJsonEnd(raw, idx)
    if (end < 0) {
      // Incomplete JSON — still streaming
      segments.push({ kind: 'text', text: raw.slice(idx) })
      break
    }

    const jsonStr = raw.slice(idx, end)
    try {
      const parsed = JSON.parse(jsonStr)
      if (parsed.type === 'result') {
        segments.push({ kind: 'result', data: parsed })
      } else {
        segments.push({ kind: 'text', text: jsonStr })
      }
    } catch {
      segments.push({ kind: 'text', text: jsonStr })
    }
    pos = end
  }
  return segments
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`
  return `$${usd.toFixed(4)}`
}

/** Render simple markdown: headings, bold, code, lists */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let inList = false
  let listItems: React.ReactNode[] = []

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(<ul key={`list-${nodes.length}`} className="cr-list">{listItems}</ul>)
      listItems = []
      inList = false
    }
  }

  const inlineFormat = (line: string, key: string): React.ReactNode => {
    // Bold, inline code, then plain text
    const parts: React.ReactNode[] = []
    const re = /(\*\*(.+?)\*\*|`([^`]+)`)/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index))
      if (m[2]) parts.push(<strong key={`${key}-b-${m.index}`}>{m[2]}</strong>)
      if (m[3]) parts.push(<code key={`${key}-c-${m.index}`} className="cr-inline-code">{m[3]}</code>)
      last = m.index + m[0].length
    }
    if (last < line.length) parts.push(line.slice(last))
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Heading
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/)
    if (hMatch) {
      flushList()
      const level = hMatch[1].length
      const Tag = `h${Math.min(level + 2, 6)}` as keyof React.JSX.IntrinsicElements
      nodes.push(<Tag key={`h-${i}`} className="cr-heading">{inlineFormat(hMatch[2], `h-${i}`)}</Tag>)
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      flushList()
      nodes.push(<hr key={`hr-${i}`} className="cr-hr" />)
      continue
    }

    // List item (numbered or bulleted)
    const liMatch = trimmed.match(/^(\d+\.|[-*])\s+(.+)/)
    if (liMatch) {
      inList = true
      listItems.push(<li key={`li-${i}`}>{inlineFormat(liMatch[2], `li-${i}`)}</li>)
      continue
    }

    // Empty line
    if (!trimmed) {
      flushList()
      continue
    }

    // Normal paragraph
    flushList()
    nodes.push(<p key={`p-${i}`} className="cr-para">{inlineFormat(trimmed, `p-${i}`)}</p>)
  }
  flushList()
  return nodes
}

function ClaudeResultCard({ data }: { data: ClaudeResult }) {
  const [expanded, setExpanded] = useState(false)
  const isSuccess = data.subtype === 'success' && !data.is_error

  const models = Object.entries(data.modelUsage ?? {})
  const totalTokensIn = models.reduce((s, [, m]) =>
    s + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0)
  const totalTokensOut = models.reduce((s, [, m]) => s + (m.outputTokens ?? 0), 0)

  return (
    <div className={`cr-card ${isSuccess ? 'cr-success' : 'cr-error'}`}>
      <div className="cr-header" onClick={() => setExpanded(!expanded)}>
        <span className={`cr-status-icon ${isSuccess ? 'cr-icon-ok' : 'cr-icon-err'}`}>
          {isSuccess ? '\u2713' : '\u2717'}
        </span>
        <span className="cr-title">
          Claude {isSuccess ? 'completed' : 'failed'}
        </span>
        <div className="cr-stats">
          <span className="cr-stat">{formatDuration(data.duration_ms)}</span>
          <span className="cr-stat-sep">/</span>
          <span className="cr-stat">{data.num_turns} turns</span>
          <span className="cr-stat-sep">/</span>
          <span className="cr-stat">{formatCost(data.total_cost_usd)}</span>
        </div>
        <span className={`cr-expand ${expanded ? 'cr-expanded' : ''}`}>{'\u25B6'}</span>
      </div>

      {/* Token summary bar — always visible */}
      <div className="cr-token-bar">
        {models.map(([name, m]) => {
          const short = name.includes('opus') ? 'Opus' : name.includes('sonnet') ? 'Sonnet' : name.includes('haiku') ? 'Haiku' : name.split('/').pop()?.split('-')[0] ?? name
          return (
            <span key={name} className="cr-model-chip" title={name}>
              {short}: {((m.inputTokens + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0)) / 1000).toFixed(0)}k in / {(m.outputTokens / 1000).toFixed(1)}k out — {formatCost(m.costUSD)}
            </span>
          )
        })}
      </div>

      {expanded && (
        <div className="cr-body">
          <div className="cr-result-text">
            {renderMarkdown(data.result)}
          </div>
          <div className="cr-meta">
            <span>Session: <code>{data.session_id?.slice(0, 8)}</code></span>
            <span>Stop: {data.stop_reason}</span>
            <span>API time: {formatDuration(data.duration_api_ms)}</span>
            <span>Tokens: {(totalTokensIn / 1000).toFixed(0)}k in / {(totalTokensOut / 1000).toFixed(1)}k out</span>
          </div>
        </div>
      )}
    </div>
  )
}

function AgentOutputRenderer({ output }: { output: string }) {
  const segments = useMemo(() => parseOutputSegments(output), [output])

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'result') {
          return <ClaudeResultCard key={`cr-${i}`} data={seg.data} />
        }
        // Plain text segment
        const text = seg.text
        if (!text.trim()) return null
        return <span key={`t-${i}`}>{text}</span>
      })}
    </>
  )
}

export default function SwarmPage({ projectPath, agentOutputs, setAgentOutputs, activity, setActivity }: Props) {
  const [swarmStatus, setSwarmStatus] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [planPhase, setPlanPhase] = useState('')
  const [workerCount, setWorkerCount] = useState(2)
  // Sync local count from actual running count
  useEffect(() => {
    if (swarmStatus?.workerCount > 0) setWorkerCount(swarmStatus.workerCount)
  }, [swarmStatus?.workerCount])
  const [activeTab, setActiveTab] = useState<string>('overview')
  const outputRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const activityRef = useRef<HTMLDivElement | null>(null)
  const [historyLogs, setHistoryLogs] = useState<{ file: string; agentId: string; phase: string; timestamp: string; size: number }[]>([])
  const [historyContent, setHistoryContent] = useState<string | null>(null)
  const [historyFile, setHistoryFile] = useState<string | null>(null)

  // Initial load + polling (status/agents/stats only — not activity)
  useEffect(() => {
    const load = async () => {
      const s = await ralph.swarm.status(projectPath)
      setSwarmStatus(s)
      setAgents(s.agents ?? [])
      if (s.stats) setStats(s.stats)
      await ralph.swarm.queue(projectPath)
    }
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [projectPath])

  // Load full activity history once on mount (if not already loaded by App)
  useEffect(() => {
    if (activity.length === 0) {
      ralph.swarm.activity(projectPath, 200).then(setActivity)
    }
  }, [projectPath])

  // Live events (agents, stats, plan — output & activity handled by App)
  useEffect(() => {
    const unsubs = [
      ralph.swarm.onAgents((_p: string, a: any) => setAgents(a)),
      ralph.swarm.onGraph((_p: string, s: any) => setStats(s)),
      ralph.swarm.onPlanPhase((_p: string, phase: string) => setPlanPhase(phase)),
      ralph.swarm.onPlanQueue(() => {}),
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
    ralph.swarm.agentOutput(projectPath, activeTab).then(output => {
      if (output) {
        // Disk log is authoritative — replace whatever live buffer had
        // Also update the global buffer so live chunks append correctly from here
        globalAgentOutputs[activeTab] = output
        setAgentOutputs(prev => ({ ...prev, [activeTab]: output }))
      }
    })
  }, [activeTab, projectPath])

  const startSwarm = useCallback(async () => {
    await ralph.swarm.start(projectPath, workerCount)
  }, [projectPath, workerCount])

  const stopSwarm = useCallback(async () => {
    await ralph.swarm.stop(projectPath)
  }, [projectPath])

  const isRunning = (swarmStatus?.workerCount ?? 0) > 0 || swarmStatus?.planning
  const isPlanning = swarmStatus?.planning ?? false

  const phaseColor = (phase: string) => {
    if (phase === 'thinking') return 'accent'
    if (phase === 'executing') return 'success'
    if (phase === 'reviewing') return 'warning'
    if (phase === 'merging') return 'info'
    if (phase === 'routing' || phase === 'claiming') return 'info'
    return 'idle'
  }

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
      default: return '\u2022'
    }
  }

  return (
    <div className="page swarm-page">
      <header className="page-header">
        <h2>Agent Flywheel</h2>
        <div className="header-actions">
          <div className="worker-controls">
            {isRunning ? (
              <>
                <button className="btn btn-sm" disabled={workerCount <= 1}
                  onClick={() => { const n = workerCount - 1; setWorkerCount(n); ralph.swarm.start(projectPath, n) }}>
                  {'\u2212'}
                </button>
                <span className="worker-count">{workerCount} agent{workerCount > 1 ? 's' : ''}</span>
                <button className="btn btn-sm btn-primary"
                  onClick={() => { const n = workerCount + 1; setWorkerCount(n); ralph.swarm.start(projectPath, n) }}>
                  +
                </button>
                <button className="btn btn-danger" onClick={stopSwarm}>Stop</button>
              </>
            ) : (
              <>
                <select className="select select-sm" value={workerCount}
                  onChange={e => setWorkerCount(Number(e.target.value))}>
                  {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} agent{n > 1 ? 's' : ''}</option>)}
                </select>
                <button className="btn btn-primary" onClick={startSwarm}>Start Swarm</button>
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
          </div>
        </div>
      )}

      {/* Agent work area */}
      <div className="card card-loop2">
        <div className="card-header-bar">
          <h3>Agents</h3>
        </div>
        <div className="agent-tabs">
          <button className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button className={`tab ${activeTab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}>
            Activity ({activity.length})
          </button>
          <button className={`tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('history')
              ralph.swarm.agentLogs(projectPath).then(logs => {
                // Filter to current session only
                const sessionStart = swarmStatus?.sessionStartedAt
                if (sessionStart) {
                  const startTs = sessionStart.replace(/[:.]/g, '-').slice(0, 19)
                  setHistoryLogs(logs.filter(l => l.file >= `agent-0_a_${startTs}`))
                } else {
                  setHistoryLogs(logs)
                }
              })
            }}>
            History
          </button>
          {agents.map(a => (
            <button key={a.id} className={`tab ${activeTab === a.id ? 'active' : ''}`}
              onClick={() => setActiveTab(a.id)}>
              <span className={`agent-dot ${a.phase}`} />
              {a.id}
              {a.currentBeadId && <span className="tab-bead">[{a.currentBeadId}]</span>}
            </button>
          ))}
          {/* Planner output tab when planning */}
          {(isPlanning || agentOutputs['planner']) && (
            <button className={`tab ${activeTab === 'planner' ? 'active' : ''}`}
              onClick={() => setActiveTab('planner')}>
              <span className={`agent-dot ${isPlanning ? 'executing' : 'idle'}`} />
              planner
            </button>
          )}
        </div>

        <div className="tab-content">
          {activeTab === 'overview' && (
            <div className="overview-grid">
              {agents.length === 0 && (
                <div className="empty-state-sm">
                  <p>No agents running. Start the swarm to begin.</p>
                </div>
              )}
              {agents.map(a => (
                <div key={a.id} className={`agent-card agent-card-${phaseColor(a.phase)}`}
                  style={{ cursor: 'pointer' }} onClick={() => setActiveTab(a.id)}>
                  <div className="agent-header">
                    <span className={`agent-dot ${a.phase}`} />
                    <strong>{a.id}</strong>
                    <span className={`badge badge-${phaseColor(a.phase)}`}>
                      {a.phase}
                    </span>
                  </div>
                  {a.currentBeadId && (
                    <p className="agent-bead">
                      <span className="agent-bead-id">[{a.currentBeadId}]</span>
                      {a.currentBeadTitle && <span> {a.currentBeadTitle}</span>}
                    </p>
                  )}
                  {a.worktreeBranch && (
                    <p className="agent-branch">Branch: {a.worktreeBranch}</p>
                  )}
                  {a.thinkingSummary && a.phase === 'thinking' && (
                    <div className="agent-thinking">
                      <span className="thinking-label">Thinking:</span>
                      <p>{a.thinkingSummary.slice(0, 200)}</p>
                    </div>
                  )}
                  <span className="agent-loops">Loop #{a.loopCount}</span>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'activity' && (
            <div className="activity-list" ref={activityRef}>
              {activity.slice().reverse().map((e, i) => (
                <div key={`${e.ts}-${e.agentId}-${i}`} className={`activity-item activity-${e.type}`}>
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
              ))}
              {activity.length === 0 && (
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
                    <span style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font)' }}>{historyFile}</span>
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
                        ralph.swarm.agentLogContent(projectPath, log.file).then(setHistoryContent)
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
            <div className="agent-output" ref={el => { outputRefs.current[activeTab] = el as any }}>
              {agentOutputs[activeTab]
                ? <AgentOutputRenderer output={agentOutputs[activeTab]} />
                : <span className="cr-waiting">Loading output...</span>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
