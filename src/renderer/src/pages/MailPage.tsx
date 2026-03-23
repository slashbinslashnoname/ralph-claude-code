import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { MailMessage } from '../types/ipc'

const sb = window.slashbot

interface MailPageProps {
  projectPath: string
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

export interface Thread {
  threadId: string
  messages: MailMessage[]   // chronological (oldest first)
  latest: MailMessage       // newest message (for preview)
  hasUnread: boolean
}

export function groupThreads(messages: MailMessage[]): Thread[] {
  const map = new Map<string, MailMessage[]>()
  for (const m of messages) {
    const arr = map.get(m.threadId) ?? []
    arr.push(m)
    map.set(m.threadId, arr)
  }
  const threads: Thread[] = []
  for (const [threadId, msgs] of map) {
    msgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    threads.push({
      threadId,
      messages: msgs,
      latest: msgs[msgs.length - 1],
      hasUnread: msgs.some(m => !m.read),
    })
  }
  // sort threads newest-first by latest message
  threads.sort((a, b) => new Date(b.latest.ts).getTime() - new Date(a.latest.ts).getTime())
  return threads
}

type FilterMode = 'all' | 'unread'

export default function MailPage({ projectPath }: MailPageProps) {
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [agentFilter, setAgentFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [isLive, setIsLive] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Mount: fetch initial messages, subscribe, listen for live updates
  useEffect(() => {
    let cancelled = false

    sb.mail.list(projectPath).then(initial => {
      if (!cancelled) setMessages(initial)
    })

    sb.mail.subscribe(projectPath).then(() => {
      if (!cancelled) setIsLive(true)
    })

    const unsub = sb.mail.onMessage((proj: string, msg: MailMessage) => {
      if (proj !== projectPath) return
      setMessages(prev => [...prev, msg])
    })
    cleanupRef.current = unsub

    return () => {
      cancelled = true
      setIsLive(false)
      cleanupRef.current?.()
      cleanupRef.current = null
      sb.mail.unsubscribe(projectPath)
    }
  }, [projectPath])

  // Derive unique agent names for filter dropdown
  const agents = useMemo(() => {
    const set = new Set<string>()
    for (const m of messages) {
      set.add(m.from)
      set.add(m.to)
    }
    return Array.from(set).sort()
  }, [messages])

  // Filter messages
  const filtered = useMemo(() => {
    let list = messages
    if (filterMode === 'unread') {
      list = list.filter(m => !m.read)
    }
    if (agentFilter) {
      list = list.filter(m => m.from === agentFilter || m.to === agentFilter)
    }
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(m =>
        m.subject.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.from.toLowerCase().includes(q) ||
        m.to.toLowerCase().includes(q),
      )
    }
    return list
  }, [messages, filterMode, agentFilter, search])

  const threads = useMemo(() => groupThreads(filtered), [filtered])

  const selectedThread = useMemo(
    () => threads.find(t => t.threadId === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  )

  const handleSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId)
  }, [])

  return (
    <div className="page mail-page">
      <div className="page-header">
        <h2>
          Mail
          {isLive && <span className="mail-live-dot" title="Live updates active" />}
        </h2>
        <p className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Filter bar */}
      <div className="mail-filter-bar">
        <div className="mail-toggle">
          <button
            className={`mail-toggle-btn ${filterMode === 'all' ? 'active' : ''}`}
            onClick={() => setFilterMode('all')}
          >
            All
          </button>
          <button
            className={`mail-toggle-btn ${filterMode === 'unread' ? 'active' : ''}`}
            onClick={() => setFilterMode('unread')}
          >
            Unread
          </button>
        </div>

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

        <input
          className="mail-search"
          type="text"
          placeholder="Search messages..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Two-pane layout */}
      <div className="mail-body">
        {/* Left: thread list */}
        <div className="mail-thread-list">
          {threads.length === 0 && (
            <div className="mail-empty">No messages</div>
          )}
          {threads.map(thread => (
            <div
              key={thread.threadId}
              className={`mail-thread-row ${selectedThreadId === thread.threadId ? 'selected' : ''} ${thread.hasUnread ? 'unread' : ''}`}
              onClick={() => handleSelectThread(thread.threadId)}
            >
              <div className="mail-thread-header">
                <span
                  className="mail-agent-badge"
                  style={{ background: agentColor(thread.latest.from) }}
                >
                  {thread.latest.from}
                </span>
                <span className="mail-arrow">&#8594;</span>
                <span
                  className="mail-agent-badge"
                  style={{ background: agentColor(thread.latest.to) }}
                >
                  {thread.latest.to}
                </span>
                <span className="mail-time">{relativeTime(thread.latest.ts)}</span>
              </div>
              <div className="mail-thread-subject">{thread.latest.subject}</div>
              <div className="mail-thread-preview">
                {thread.latest.body.length > 120
                  ? thread.latest.body.slice(0, 120) + '...'
                  : thread.latest.body}
              </div>
              {thread.messages.length > 1 && (
                <span className="mail-thread-count">{thread.messages.length} messages</span>
              )}
            </div>
          ))}
        </div>

        {/* Right: detail pane */}
        <div className="mail-detail">
          {selectedThread ? (
            <>
              <h3 className="mail-detail-subject">{selectedThread.latest.subject}</h3>
              <div className="mail-detail-thread-id">Thread: {selectedThread.threadId}</div>
              <div className="mail-detail-messages">
                {selectedThread.messages.map((msg, i) => (
                  <div key={`${msg.ts}-${i}`} className="mail-detail-msg">
                    <div className="mail-detail-msg-header">
                      <span
                        className="mail-agent-badge"
                        style={{ background: agentColor(msg.from) }}
                      >
                        {msg.from}
                      </span>
                      <span className="mail-arrow">&#8594;</span>
                      <span
                        className="mail-agent-badge"
                        style={{ background: agentColor(msg.to) }}
                      >
                        {msg.to}
                      </span>
                      <span className="mail-time">{relativeTime(msg.ts)}</span>
                    </div>
                    <div className="mail-detail-msg-body">{msg.body}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="mail-empty">Select a thread to view messages</div>
          )}
        </div>
      </div>
    </div>
  )
}
