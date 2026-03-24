import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ActivityEvent } from '../types/ipc'

const sb = window.slashbot

interface ThreadsPageProps {
  projectPath: string
  activity: ActivityEvent[]
}

// Agent badge colors — deterministic palette keyed by agent name
const AGENT_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e',
  '#3b82f6', '#14b8a6', '#f97316', '#ef4444', '#a855f7',
]

export function agentColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]
}

export function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
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
  split: '\u2702',
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
  split: 'accent',
}

export interface BeadThread {
  beadId: string
  beadTitle: string
  events: ActivityEvent[]    // chronological (oldest first)
  latest: ActivityEvent      // newest event (for sorting/preview)
  agents: string[]           // unique agents involved
}

export function groupBeadThreads(events: ActivityEvent[]): BeadThread[] {
  const map = new Map<string, ActivityEvent[]>()
  for (const e of events) {
    if (!e.beadId) continue
    const arr = map.get(e.beadId) ?? []
    arr.push(e)
    map.set(e.beadId, arr)
  }
  const threads: BeadThread[] = []
  for (const [beadId, evts] of map) {
    evts.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    const agents = [...new Set(evts.map(e => e.agentId))]
    const titleEvent = evts.find(e => e.beadTitle)
    threads.push({
      beadId,
      beadTitle: titleEvent?.beadTitle ?? beadId,
      events: evts,
      latest: evts[evts.length - 1],
      agents,
    })
  }
  // Sort threads newest-first by latest event
  threads.sort((a, b) => new Date(b.latest.ts).getTime() - new Date(a.latest.ts).getTime())
  return threads
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

export default function ThreadsPage({ projectPath, activity }: ThreadsPageProps) {
  const [allEvents, setAllEvents] = useState<ActivityEvent[]>(activity)
  const [agentFilter, setAgentFilter] = useState<string>('')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [selectedBeadId, setSelectedBeadId] = useState<string | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // Load full activity on mount
  useEffect(() => {
    sb.swarm.activity(projectPath, 500).then((evts: ActivityEvent[]) => {
      setAllEvents(evts)
    })
  }, [projectPath])

  // Merge in live events from the global activity buffer
  useEffect(() => {
    setAllEvents(prev => {
      if (activity.length === 0) return prev
      // Merge: add events not already in prev (by ts+agentId+type key)
      const keys = new Set(prev.map(e => `${e.ts}:${e.agentId}:${e.type}`))
      const newEvts = activity.filter(e => !keys.has(`${e.ts}:${e.agentId}:${e.type}`))
      if (newEvts.length === 0) return prev
      return [...prev, ...newEvts]
    })
  }, [activity])

  // Derive unique agents and event types for filter dropdowns
  const agents = useMemo(() => {
    const set = new Set<string>()
    for (const e of allEvents) set.add(e.agentId)
    return Array.from(set).sort()
  }, [allEvents])

  const eventTypes = useMemo(() => {
    const set = new Set<string>()
    for (const e of allEvents) set.add(e.type)
    return Array.from(set).sort()
  }, [allEvents])

  // Filter events
  const filtered = useMemo(() => {
    let list = allEvents
    if (agentFilter) {
      list = list.filter(e => e.agentId === agentFilter)
    }
    if (typeFilter) {
      list = list.filter(e => e.type === typeFilter)
    }
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(e =>
        (e.beadTitle?.toLowerCase().includes(q)) ||
        (e.summary?.toLowerCase().includes(q)) ||
        e.agentId.toLowerCase().includes(q) ||
        (e.beadId?.toLowerCase().includes(q)),
      )
    }
    return list
  }, [allEvents, agentFilter, typeFilter, search])

  const threads = useMemo(() => groupBeadThreads(filtered), [filtered])

  const selectedThread = useMemo(
    () => threads.find(t => t.beadId === selectedBeadId) ?? null,
    [threads, selectedBeadId],
  )

  const handleSelectThread = useCallback((beadId: string) => {
    setSelectedBeadId(beadId)
  }, [])

  // Auto-scroll detail pane when new events arrive for selected thread
  useEffect(() => {
    if (detailRef.current && selectedThread) {
      detailRef.current.scrollTop = detailRef.current.scrollHeight
    }
  }, [selectedThread?.events.length])

  return (
    <div className="page threads-page">
      <div className="page-header">
        <h2>Threads</h2>
        <p className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {threads.length} bead{threads.length !== 1 ? 's' : ''} with activity
        </p>
      </div>

      {/* Filter bar */}
      <div className="mail-filter-bar">
        <select
          className="mail-agent-select"
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
        >
          <option value="">All agents</option>
          {agents.map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <select
          className="mail-agent-select"
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
        >
          <option value="">All events</option>
          {eventTypes.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <input
          className="mail-search"
          type="text"
          placeholder="Search threads..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Two-pane layout */}
      <div className="mail-body">
        {/* Left: thread list */}
        <div className="mail-thread-list">
          {threads.length === 0 && (
            <div className="mail-empty">No bead activity yet</div>
          )}
          {threads.map(thread => (
            <div
              key={thread.beadId}
              className={`mail-thread-row ${selectedBeadId === thread.beadId ? 'selected' : ''}`}
              onClick={() => handleSelectThread(thread.beadId)}
            >
              <div className="mail-thread-header">
                {thread.agents.map(agent => (
                  <span
                    key={agent}
                    className="mail-agent-badge"
                    style={{ background: agentColor(agent) }}
                  >
                    {agent}
                  </span>
                ))}
                <span className="mail-time">{relativeTime(thread.latest.ts)}</span>
              </div>
              <div className="mail-thread-subject">{thread.beadTitle}</div>
              <div className="mail-thread-preview">
                {thread.latest.summary
                  ? (thread.latest.summary.length > 120
                    ? thread.latest.summary.slice(0, 120) + '...'
                    : thread.latest.summary)
                  : `${thread.latest.type} by ${thread.latest.agentId}`}
              </div>
              <span className="mail-thread-count">{thread.events.length} event{thread.events.length !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>

        {/* Right: detail pane */}
        <div className="mail-detail" ref={detailRef}>
          {selectedThread ? (
            <>
              <h3 className="mail-detail-subject">{selectedThread.beadTitle}</h3>
              <div className="mail-detail-thread-id">Bead: {selectedThread.beadId}</div>
              <div className="bead-detail-timeline">
                {selectedThread.events.map((evt, i) => (
                  <div key={`${evt.ts}-${i}`} className="bead-timeline-event">
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
                          {evt.filesChanged.map(f => (
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
              </div>
            </>
          ) : (
            <div className="mail-empty">Select a bead thread to view its activity timeline</div>
          )}
        </div>
      </div>
    </div>
  )
}
