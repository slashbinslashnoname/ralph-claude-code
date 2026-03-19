/**
 * PlanPage — trigger swarm plan + encode. Progress shown live.
 */
import React, { useEffect, useState } from 'react'

export default function PlanPage({ projectPath }: { projectPath: string }): JSX.Element {
  const [planning,  setPlanning]  = useState(false)
  const [planPhase, setPlanPhase] = useState('')
  const [request,   setRequest]   = useState('')
  const [msg,       setMsg]       = useState<string | null>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 5000) }

  useEffect(() => {
    const unsubs = [
      window.ralph.swarm.onPlanPhase((p, phase) => {
        if (p !== projectPath) return
        setPlanning(phase !== 'done')
        setPlanPhase(phase)
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
    setPlanning(true)
    setPlanPhase('planning-1')
    const r = await window.ralph.swarm.inject(projectPath, request.trim())
    if (!r.ok) { flash(`Failed: ${r.error}`); setPlanning(false) }
    else {
      setRequest('')
      flash('Planning started — you can navigate away, it runs in the background.')
    }
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
          <span style={{ color: 'var(--yellow)' }}>{phaseLabel}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>Running in background</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        <div className="stat-card">
          <div className="stat-label" style={{ marginBottom: 8 }}>Generate / regenerate swarm plan</div>
          <textarea
            value={request}
            onChange={e => setRequest(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void handleInject() } }}
            rows={4}
            disabled={planning}
            placeholder="Describe what to build… (Ctrl+Enter to run Plan+Encode)"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text)', padding: '8px 10px',
              fontFamily: 'monospace', fontSize: 12, resize: 'vertical', outline: 'none'
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button className="btn btn-primary btn-sm"
              onClick={() => void handleInject()} disabled={planning || !request.trim()}>
              {planning ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '⬡'} Plan + Encode
            </button>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Ctrl+Enter</span>
          </div>
        </div>
      </div>
    </>
  )
}
