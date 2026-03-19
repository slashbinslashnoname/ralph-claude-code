/**
 * AgentMailPage — live view of the swarm agent mail log.
 * Shows messages from all agents: claimed, completed, failed, info.
 */
import React, { useEffect, useRef, useState } from 'react'

interface MailMsg {
  ts: string; from: string; type: string
  beadId?: string; files?: string[]; text?: string
}

const TYPE_COLOR: Record<string, string> = {
  completed: 'var(--green)',
  failed:    'var(--red)',
  claimed:   'var(--yellow)',
  started:   'var(--blue)',
  stopped:   'var(--muted)',
  info:      'var(--muted)',
}

const TYPE_ICON: Record<string, string> = {
  completed: '✓',
  failed:    '✗',
  claimed:   '→',
  started:   '▶',
  stopped:   '■',
  info:      'ℹ',
}

export default function AgentMailPage({ projectPath }: { projectPath: string }): JSX.Element {
  const [mail,    setMail]    = useState<MailMsg[]>([])
  const [loading, setLoading] = useState(false)
  const [filter,  setFilter]  = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    const msgs = await window.ralph.swarm.mail(projectPath, 200) as MailMsg[]
    setMail(msgs)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    const unsub = window.ralph.swarm.onMail((p, msg) => {
      if (p !== projectPath) return
      setMail(prev => [...prev, msg as MailMsg].slice(-500))
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    })
    return () => unsub()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const visible = filter
    ? mail.filter(m => JSON.stringify(m).toLowerCase().includes(filter.toLowerCase()))
    : mail

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">✉ Agent Mail</div>
          <div className="page-sub">Swarm coordination log — {mail.length} messages</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="search"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              background: 'var(--surface2)', border: '1px solid var(--border)',
              color: 'var(--text)', borderRadius: 4, padding: '4px 10px',
              fontSize: 12, outline: 'none', width: 180
            }}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↻'} Reload
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setMail([])}>Clear</button>
        </div>
      </div>

      <div style={{
        flex: 1, overflowY: 'auto', padding: '8px 0',
        fontFamily: 'monospace', fontSize: 12
      }}>
        {visible.length === 0 ? (
          <div className="state-box">
            <div className="state-icon">✉</div>
            <div className="state-desc">No agent mail yet. Start the swarm to see coordination messages.</div>
          </div>
        ) : (
          visible.map((m, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '80px 80px 70px 1fr',
              gap: 12, padding: '4px 24px', lineHeight: 1.6,
              borderBottom: '1px solid var(--border)',
              borderLeft: `3px solid ${TYPE_COLOR[m.type] ?? 'var(--muted)'}`,
              marginBottom: 1
            }}>
              <span style={{ color: 'var(--muted)', fontSize: 10, alignSelf: 'center' }}>
                {new Date(m.ts).toLocaleTimeString()}
              </span>
              <span style={{ color: 'var(--accent)', fontWeight: 600, alignSelf: 'center' }}>
                {m.from}
              </span>
              <span style={{ color: TYPE_COLOR[m.type] ?? 'var(--muted)', fontWeight: 600, alignSelf: 'center' }}>
                {TYPE_ICON[m.type] ?? '·'} {m.type}
              </span>
              <span style={{ color: 'var(--muted)', alignSelf: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.beadId ? <span style={{ color: 'var(--text)', marginRight: 6 }}>[{m.beadId}]</span> : null}
                {m.text ?? ''}
                {m.files && m.files.length > 0 ? (
                  <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
                    +{m.files.length} files
                  </span>
                ) : null}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="summary-bar">
        Showing {visible.length} of {mail.length} messages
        {filter && ` · search: "${filter}"`}
      </div>
    </>
  )
}
