import React, { useState, useEffect, useCallback, useMemo } from 'react'
import AgentOutputRenderer from './AgentOutputRenderer'

interface ActivityEvent {
  ts: string
  agentId: string
  type: string
  beadId?: string
  beadTitle?: string
  summary?: string
  filesChanged?: string[]
  branch?: string
  commitSha?: string
}

interface LogEntry {
  file: string
  agentId: string
  phase: string
  timestamp: string
  size: number
}

interface Props {
  beadId: string
  beadStatus: string
  projectPath: string
}

const EVENT_ICONS: Record<string, string> = {
  claimed: '\u2691',
  thinking: '\u2699',
  executing: '\u25B6',
  merged: '\u2714',
  completed: '\u2713',
  failed: '\u2717',
  stopped: '\u25A0',
  paused: '\u23F8',
  resumed: '\u23F5',
  started: '\u25CB',
  rollback: '\u21A9',
}

const EVENT_BADGE: Record<string, string> = {
  claimed: 'warning',
  thinking: 'accent',
  executing: 'info',
  merged: 'success',
  completed: 'success',
  failed: 'danger',
  stopped: 'idle',
  paused: 'idle',
  resumed: 'info',
  started: 'idle',
  rollback: 'danger',
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch { return ts }
}

const EVENTS_PAGE_SIZE = 50

export default function BeadDetailPanel({ beadId, beadStatus, projectPath }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logContent, setLogContent] = useState<string | null>(null)
  const [logFile, setLogFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'timeline' | 'logs'>('timeline')
  const [visibleCount, setVisibleCount] = useState(EVENTS_PAGE_SIZE)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      // Fetch activity events for this bead
      const activity: ActivityEvent[] = await window.slashbot.swarm.activity(projectPath, 500)
      const beadEvents = activity.filter((e) => e.beadId === beadId)

      if (!cancelled) setEvents(beadEvents)

      // Fetch matching logs
      const thinkExecEvents = beadEvents.filter((e) =>
        ['thinking', 'executing'].includes(e.type)
      )
      const allLogs: LogEntry[] = await window.slashbot.swarm.agentLogs(projectPath)
      const matched: LogEntry[] = []

      for (const evt of thinkExecEvents) {
        const evtTime = new Date(evt.ts).getTime()
        const phase = evt.type === 'thinking' ? 'think' : 'execute'
        const candidates = allLogs.filter(
          (l) => l.agentId === evt.agentId && l.phase === phase
        )
        let best: LogEntry | null = null
        let bestDiff = Infinity
        for (const c of candidates) {
          const logTime = new Date(c.timestamp).getTime()
          const diff = Math.abs(logTime - evtTime)
          if (diff < bestDiff) { bestDiff = diff; best = c }
        }
        if (best && !matched.some((m) => m.file === best!.file)) matched.push(best)
      }

      // Also find review logs near execute events
      for (const evt of thinkExecEvents.filter((e) => e.type === 'executing')) {
        const evtTime = new Date(evt.ts).getTime()
        const reviews = allLogs.filter(
          (l) => l.agentId === evt.agentId && l.phase === 'review'
        )
        for (const r of reviews) {
          const logTime = new Date(r.timestamp).getTime()
          if (
            logTime > evtTime &&
            logTime - evtTime < 30 * 60_000 &&
            !matched.some((m) => m.file === r.file)
          ) {
            matched.push(r)
          }
        }
      }

      if (!cancelled) {
        setLogs(matched)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [beadId, projectPath])

  const openLog = useCallback(
    async (file: string) => {
      setLogFile(file)
      const content = await window.slashbot.swarm.agentLogContent(projectPath, file)
      setLogContent(content)
    },
    [projectPath]
  )

  const closeLog = useCallback(() => {
    setLogContent(null)
    setLogFile(null)
  }, [])

  // Reset pagination when bead changes
  useEffect(() => { setVisibleCount(EVENTS_PAGE_SIZE) }, [beadId])

  const visibleEvents = useMemo(
    () => events.slice(0, visibleCount),
    [events, visibleCount]
  )
  const hasMore = visibleCount < events.length

  const showMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + EVENTS_PAGE_SIZE, events.length))
  }, [events.length])

  // Extract think summary from events
  const thinkEvent = useMemo(() => events.find((e) => e.type === 'thinking' && e.summary), [events])
  // Extract failure info
  const failEvent = useMemo(() => events.find((e) => e.type === 'failed'), [events])
  // Agent assignment
  const claimEvent = useMemo(() => events.find((e) => e.type === 'claimed'), [events])

  if (loading) {
    return (
      <div className="bead-detail-panel">
        <p className="bead-detail-loading">Loading audit trail...</p>
      </div>
    )
  }

  return (
    <div className="bead-detail-panel">
      {/* Summary bar */}
      <div className="bead-detail-summary">
        {claimEvent && (
          <div className="bead-detail-field">
            <span className="bead-detail-label">Agent</span>
            <span className="tag tag-agent">{claimEvent.agentId}</span>
          </div>
        )}
        {claimEvent && (
          <div className="bead-detail-field">
            <span className="bead-detail-label">Claimed</span>
            <span className="bead-detail-value">{formatTime(claimEvent.ts)}</span>
          </div>
        )}
        {events.length > 0 && (
          <div className="bead-detail-field">
            <span className="bead-detail-label">Events</span>
            <span className="bead-detail-value">{events.length}</span>
          </div>
        )}
        {failEvent?.summary && (
          <div className="bead-detail-field bead-detail-error">
            <span className="bead-detail-label">Error</span>
            <span className="bead-detail-value">{failEvent.summary}</span>
          </div>
        )}
      </div>

      {/* Think summary */}
      {thinkEvent?.summary && (
        <div className="bead-detail-think">
          <span className="bead-detail-label">Think Summary</span>
          <p className="bead-detail-think-text">{thinkEvent.summary}</p>
        </div>
      )}

      {/* Tab bar */}
      <div className="bead-detail-tabs">
        <button
          className={`tab ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline ({events.length})
        </button>
        <button
          className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Logs ({logs.length})
        </button>
      </div>

      {/* Timeline tab */}
      {activeTab === 'timeline' && (
        <div className="bead-detail-timeline">
          {events.length === 0 ? (
            <p className="bead-detail-empty">No activity yet</p>
          ) : (
            <>
              {visibleEvents.map((evt, i) => (
                <div key={`${evt.ts}-${evt.agentId}-${i}`} className="bead-timeline-event">
                  <span className="bead-timeline-icon">
                    {EVENT_ICONS[evt.type] || '\u25CB'}
                  </span>
                  <div className="bead-timeline-line" />
                  <div className="bead-timeline-content">
                    <div className="bead-timeline-header">
                      <span className={`badge badge-${EVENT_BADGE[evt.type] || 'idle'}`}>
                        {evt.type}
                      </span>
                      <span className="bead-timeline-agent">{evt.agentId}</span>
                      <span className="bead-timeline-time">{formatTime(evt.ts)}</span>
                    </div>
                    {evt.summary && (
                      <p className="bead-timeline-summary">{evt.summary}</p>
                    )}
                    {evt.filesChanged && evt.filesChanged.length > 0 && (
                      <div className="bead-timeline-files">
                        {evt.filesChanged.map((f) => (
                          <span key={f} className="tag">{f}</span>
                        ))}
                      </div>
                    )}
                    {evt.branch && (
                      <span className="tag tag-branch">{evt.branch}</span>
                    )}
                  </div>
                </div>
              ))}
              {hasMore && (
                <button className="btn btn-sm btn-ghost bead-timeline-show-more" onClick={showMore}>
                  Show more ({events.length - visibleCount} remaining)
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Logs tab */}
      {activeTab === 'logs' && (
        <div className="bead-detail-logs-tab">
          {logContent && logFile ? (
            <div>
              <div className="bead-detail-log-header">
                <button className="btn btn-xs btn-ghost" onClick={closeLog}>
                  {'\u2190'} Back
                </button>
                <span className="bead-detail-log-filename">{logFile}</span>
              </div>
              <div className="bead-log-content agent-output">
                <AgentOutputRenderer output={logContent.slice(-10000)} />
              </div>
            </div>
          ) : logs.length > 0 ? (
            <div className="bead-log-list">
              {logs.map((log) => (
                <div
                  key={log.file}
                  className="bead-log-item"
                  onClick={() => openLog(log.file)}
                >
                  <span
                    className={`agent-dot ${
                      log.phase === 'execute'
                        ? 'executing'
                        : log.phase === 'think'
                          ? 'thinking'
                          : 'reviewing'
                    }`}
                  />
                  <span>{log.agentId}</span>
                  <span
                    className={`badge badge-${
                      log.phase === 'execute'
                        ? 'success'
                        : log.phase === 'think'
                          ? 'accent'
                          : 'warning'
                    }`}
                  >
                    {log.phase}
                  </span>
                  <span className="bead-detail-log-size">
                    {(log.size / 1024).toFixed(0)}KB
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="bead-detail-empty">No logs found for this bead.</p>
          )}
        </div>
      )}
    </div>
  )
}
