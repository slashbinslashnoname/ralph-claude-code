/**
 * PlanPage — edit .ralph/fix_plan.md (classic loop tasks) and .ralph/plan.md (swarm plan).
 * Planning runs in the background; navigating away does not cancel it.
 */
import React, { useCallback, useEffect, useState } from 'react'

type Tab = 'fixplan' | 'swarmplan'

function Editor({
  label, relPath, projectPath
}: { label: string; relPath: string; projectPath: string }): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [draft,   setDraft]   = useState('')
  const [editing, setEditing] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState<string | null>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 4000) }

  const load = useCallback(async () => {
    const r = await window.ralph.readFile(projectPath, relPath) as { ok: boolean; content?: string; error?: string }
    if (r.ok && r.content !== undefined) {
      setContent(r.content)
      if (!editing) setDraft(r.content)
    } else {
      setContent(null)
    }
  }, [projectPath, relPath, editing])

  useEffect(() => { void load() }, [load])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    const r = await window.ralph.writeFile(projectPath, relPath, draft) as { ok: boolean; error?: string }
    setSaving(false)
    if (r.ok) {
      setContent(draft)
      setEditing(false)
      flash('Saved')
    } else {
      flash(`Error: ${r.error}`)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {msg && (
        <div style={{ fontSize: 12, color: 'var(--accent)', padding: '6px 0' }}>{msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {!editing ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => void load()}>↻ Reload</button>
            {content !== null && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(content); setEditing(true) }}>
                ✎ Edit
              </button>
            )}
          </>
        ) : (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn btn-sm" style={{ background: 'var(--green)', color: '#fff' }}
              onClick={() => void handleSave()} disabled={saving}>
              {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '✓ Save'}
            </button>
          </>
        )}
      </div>

      {content === null ? (
        <div className="state-box">
          <div className="state-icon">📄</div>
          <div className="state-desc">{label} not found in this project.</div>
        </div>
      ) : editing ? (
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{
            minHeight: 400, width: '100%', boxSizing: 'border-box',
            background: 'var(--surface2)', border: '1px solid var(--accent)',
            borderRadius: 6, color: 'var(--text)', padding: '12px',
            fontFamily: 'monospace', fontSize: 12, resize: 'vertical', outline: 'none', lineHeight: 1.6
          }}
        />
      ) : (
        <pre style={{
          whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--text)',
          background: 'var(--surface2)', borderRadius: 8, padding: 16,
          border: '1px solid var(--border)', lineHeight: 1.8, margin: 0,
          maxHeight: 'calc(100vh - 280px)', overflowY: 'auto'
        }}>
          {content || <span style={{ color: 'var(--muted)' }}>(empty file)</span>}
        </pre>
      )}
    </div>
  )
}

export default function PlanPage({ projectPath }: { projectPath: string }): JSX.Element {
  const [tab,      setTab]      = useState<Tab>('fixplan')
  const [planning, setPlanning] = useState(false)
  const [planPhase, setPlanPhase] = useState('')
  const [request,  setRequest]  = useState('')
  const [msg,      setMsg]      = useState<string | null>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 5000) }

  // Listen for swarm planning events in background
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
      setTab('swarmplan')
    }
  }

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
          <span style={{ color: 'var(--yellow)' }}>
            {planPhase === 'encoding'     ? 'Step 2 — Encoding plan to beads…'
              : planPhase === 'synthesizing' ? 'Step 1 — Synthesizing plans…'
              : planPhase === 'done'        ? '✓ Complete'
              : `Step 1 — Generating ${planPhase}…`}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>Running in background</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
          {([['fixplan', '📝 Fix Plan (.ralph/fix_plan.md)'], ['swarmplan', '⬡ Swarm Plan (.ralph/plan.md)']] as const).map(([id, label]) => (
            <button key={id}
              className={`btn btn-ghost btn-sm${tab === id ? ' active' : ''}`}
              style={{ fontSize: 12, opacity: tab === id ? 1 : 0.5 }}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'fixplan' && (
          <Editor label="fix_plan.md" relPath=".ralph/fix_plan.md" projectPath={projectPath} />
        )}

        {tab === 'swarmplan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Inject / re-plan */}
            <div className="stat-card">
              <div className="stat-label" style={{ marginBottom: 8 }}>Generate / regenerate swarm plan</div>
              <textarea
                value={request}
                onChange={e => setRequest(e.target.value)}
                onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void handleInject() } }}
                rows={3}
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

            <Editor label="plan.md" relPath=".ralph/plan.md" projectPath={projectPath} />
          </div>
        )}
      </div>
    </>
  )
}
