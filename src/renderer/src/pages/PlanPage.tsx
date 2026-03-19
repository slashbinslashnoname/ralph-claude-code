/**
 * PlanPage — submit plan requests + manage the plan queue.
 */
import React, { useEffect, useState } from 'react'

type QueueItem = { id: string; request: string }

export default function PlanPage({ projectPath }: { projectPath: string }): JSX.Element {
  const [planning,  setPlanning]  = useState(false)
  const [planPhase, setPlanPhase] = useState('')
  const [request,   setRequest]   = useState('')
  const [queue,     setQueue]     = useState<QueueItem[]>([])
  const [msg,       setMsg]       = useState<string | null>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 5000) }

  // Load initial queue + subscribe to events
  useEffect(() => {
    window.ralph.swarm.queue(projectPath).then(setQueue).catch(() => {})

    const unsubs = [
      window.ralph.swarm.onPlanPhase((p, phase) => {
        if (p !== projectPath) return
        setPlanning(phase !== 'done')
        setPlanPhase(phase)
      }),
      window.ralph.swarm.onPlanQueue((p, q) => {
        if (p !== projectPath) return
        setQueue(q)
      }),
      window.ralph.swarm.onStopped((p) => {
        if (p !== projectPath) return
        setPlanning(false)
      }),
      window.ralph.swarm.onGraph((p) => {
        if (p !== projectPath) return
        setPlanning(false)
        setPlanPhase('done')
      }),
    ]
    return () => unsubs.forEach(f => f())
  }, [projectPath])

  const handleInject = async (): Promise<void> => {
    if (!request.trim()) return
    const text = request.trim()
    setRequest('')
    const r = await window.ralph.swarm.inject(projectPath, text)
    if (!r.ok) flash(`Failed: ${r.error}`)
    else flash('Queued! Will run when planner is free.')
  }

  const handleRemove = async (id: string): Promise<void> => {
    await window.ralph.swarm.queueRemove(projectPath, id)
  }

  const phaseLabel = planPhase === 'encoding'     ? 'Step 2 — Encoding plan to beads…'
                   : planPhase === 'synthesizing' ? 'Step 1 — Synthesizing plans…'
                   : planPhase === 'done'         ? '✓ Complete'
                   : planPhase                    ? `Step 1 — Generating ${planPhase}…`
                   : ''

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">📋 Plan</div>
          <div className="page-sub" style={{ fontFamily: 'monospace' }}>{projectPath}</div>
        </div>
      </div>

      {msg && (
        <div style={{ padding: '8px 24px', background: 'var(--surface2)', fontSize: 12, color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>
          {msg}
        </div>
      )}

      {planning && (
        <div style={{
          padding: '8px 24px', background: '#1c1a00', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12
        }}>
          <span className="spinner" style={{ width: 12, height: 12 }} />
          <span style={{ color: 'var(--yellow)' }}>{phaseLabel || 'Planning…'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>Running in background</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Input ── */}
        <div className="stat-card">
          <div className="stat-label" style={{ marginBottom: 8 }}>Add plan request</div>
          <textarea
            value={request}
            onChange={e => setRequest(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void handleInject() } }}
            rows={4}
            placeholder="Describe what to build… (Ctrl+Enter to queue)"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text)', padding: '8px 10px',
              fontFamily: 'monospace', fontSize: 12, resize: 'vertical', outline: 'none'
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button className="btn btn-primary btn-sm"
              onClick={() => void handleInject()} disabled={!request.trim()}>
              ⬡ Queue Plan
            </button>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Ctrl+Enter</span>
          </div>
        </div>

        {/* ── Queue ── */}
        {queue.length > 0 && (
          <div className="stat-card">
            <div className="stat-label" style={{ marginBottom: 10 }}>
              Plan queue ({queue.length} pending)
            </div>
            {queue.map((item, i) => (
              <div key={item.id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '8px 0', borderBottom: i < queue.length - 1 ? '1px solid var(--border)' : 'none'
              }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 20, paddingTop: 1 }}>
                  {i === 0 && planning ? '▶' : String(i + 1)}
                </span>
                <span style={{ flex: 1, fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-word', color: i === 0 && planning ? 'var(--yellow)' : 'var(--text)' }}>
                  {item.request}
                </span>
                {!(i === 0 && planning) && (
                  <button
                    onClick={() => void handleRemove(item.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: '0 4px', lineHeight: 1 }}
                    title="Remove from queue"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {queue.length === 0 && !planning && (
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '16px 0' }}>
            Queue is empty — add a plan request above.
          </div>
        )}
      </div>
    </>
  )
}
