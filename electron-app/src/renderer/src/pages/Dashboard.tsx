import React, { useCallback, useEffect, useState } from 'react'

type Status = {
  timestamp: string; loop_count: number; calls_made_this_hour: number
  max_calls_per_hour: number; last_action: string; status: string
  exit_reason: string; next_reset?: string
}
type Progress = { status: string; indicator?: string; elapsed_seconds?: number; last_output?: string }
type Circuit  = {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN'
  consecutive_no_progress: number; consecutive_same_error: number
  total_opens: number; reason: string; opened_at?: string
}

const CIRCUIT_COLOR: Record<string, string> = {
  CLOSED:    'var(--green)', HALF_OPEN: 'var(--yellow)', OPEN: 'var(--red)'
}
const STATUS_COLOR: Record<string, string> = {
  running: 'var(--green)', waiting: 'var(--yellow)', rate_limited: 'var(--yellow)',
  error_detected: 'var(--red)', completed: 'var(--blue)', halted: 'var(--red)'
}

function fmtElapsed(s?: number): string {
  if (!s) return '—'
  const m = Math.floor(s / 60), sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

function QuotaBar({ used, max }: { used: number; max: number }): JSX.Element {
  const pct   = max > 0 ? Math.min(100, (used / max) * 100) : 0
  const color = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
        <span>API quota</span><span>{used} / {max} calls/hr</span>
      </div>
      <div style={{ height: 6, background: 'var(--surface2)', borderRadius: 99 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.4s' }} />
      </div>
    </div>
  )
}

interface Props {
  projectPath: string
  onRunningChange: (running: boolean) => void
}

export default function Dashboard({ projectPath, onRunningChange }: Props): JSX.Element {
  const [status,   setStatus]   = useState<Status | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [circuit,  setCircuit]  = useState<Circuit | null>(null)
  const [running,  setRunning]  = useState(false)
  const [starting, setStarting] = useState(false)
  const [msg,      setMsg]      = useState<string | null>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 3500) }

  const setRunningState = useCallback((r: boolean) => {
    setRunning(r)
    onRunningChange(r)
  }, [onRunningChange])

  const load = useCallback(async () => {
    const snap = await window.ralph.readStatus(projectPath)
    if (snap.status)   setStatus(snap.status as Status)
    if (snap.progress) setProgress(snap.progress as Progress)
    if (snap.circuit)  setCircuit(snap.circuit as Circuit)
    const r = await window.ralph.ralphRunning(projectPath)
    setRunningState(r)
  }, [projectPath, setRunningState])

  useEffect(() => {
    load()
    window.ralph.subscribeStatus(projectPath)

    const unsubs = [
      window.ralph.onStatusUpdate((p, d) => { if (p === projectPath) setStatus(d as Status) }),
      window.ralph.onProgressUpdate((p, d) => { if (p === projectPath) setProgress(d as Progress) }),
      window.ralph.onCircuitUpdate((p, d) => { if (p === projectPath) setCircuit(d as Circuit) }),
      window.ralph.onRalphExit((p) => { if (p === projectPath) { setRunningState(false); load() } })
    ]
    return () => { unsubs.forEach(f => f()); window.ralph.unsubscribeStatus(projectPath) }
  }, [projectPath, load, setRunningState])

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    const r = await window.ralph.startRalph(projectPath)
    setStarting(false)
    if (r.ok) setRunningState(true)
    else flash(`Failed: ${r.error}`)
  }

  const handleStop = async (): Promise<void> => {
    await window.ralph.stopRalph(projectPath)
    setRunningState(false)
  }

  const handleResetCircuit = async (): Promise<void> => {
    const r = await window.ralph.resetCircuit(projectPath)
    if (r.ok) { flash('Circuit reset → CLOSED'); load() }
    else flash(`Error: ${r.error}`)
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">◉ Dashboard</div>
          <div className="page-sub" style={{ fontFamily: 'monospace' }}>{projectPath}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => window.ralph.resetSession(projectPath).then(() => flash('Session reset'))}>
            Reset session
          </button>
          {circuit?.state === 'OPEN' && (
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--yellow)' }} onClick={handleResetCircuit}>
              Reset circuit
            </button>
          )}
          {running
            ? <button className="btn btn-sm" style={{ background: 'var(--red)', color: '#fff' }} onClick={handleStop}>■ Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={handleStart} disabled={starting}>
                {starting ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '▶'} Start
              </button>
          }
        </div>
      </div>

      {msg && <div style={{ padding: '8px 24px', background: 'var(--surface2)', fontSize: 12, color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>{msg}</div>}

      <div style={{ padding: '20px 24px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, overflowY: 'auto' }}>
        <div className="stat-card">
          <div className="stat-label">Loop</div>
          <div className="stat-value">{status?.loop_count ?? '—'}</div>
          <div className="stat-sub" style={{ color: STATUS_COLOR[status?.status ?? ''] ?? 'var(--muted)' }}>{status?.status ?? 'unknown'}</div>
        </div>

        <div className="stat-card">
          <div className="stat-label">Process</div>
          <div className="stat-value" style={{ fontSize: 20 }}>
            {running
              ? <span style={{ color: 'var(--green)' }}>● Running</span>
              : <span style={{ color: 'var(--muted)' }}>○ Idle</span>}
          </div>
          {running && progress?.elapsed_seconds !== undefined && (
            <div className="stat-sub">{fmtElapsed(progress.elapsed_seconds)} in current call</div>
          )}
        </div>

        <div className="stat-card" style={{ gridColumn: '1 / -1' }}>
          <QuotaBar used={status?.calls_made_this_hour ?? 0} max={status?.max_calls_per_hour ?? 100} />
          {status?.next_reset && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Resets in {status.next_reset}</div>
          )}
        </div>

        <div className="stat-card" style={{ gridColumn: '1 / -1' }}>
          <div className="stat-label">Circuit breaker</div>
          {circuit ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: CIRCUIT_COLOR[circuit.state] ?? 'var(--muted)' }}>
                  {circuit.state}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{circuit.reason}</span>
              </div>
              <div style={{ display: 'flex', gap: 24, marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                <span>No progress: <b style={{ color: 'var(--text)' }}>{circuit.consecutive_no_progress}</b></span>
                <span>Same error:  <b style={{ color: 'var(--text)' }}>{circuit.consecutive_same_error}</b></span>
                <span>Total opens: <b style={{ color: 'var(--text)' }}>{circuit.total_opens}</b></span>
              </div>
              {circuit.state === 'OPEN' && circuit.opened_at && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>
                  Opened at {new Date(circuit.opened_at).toLocaleTimeString()}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>No state file — loop not started yet</div>
          )}
        </div>

        {progress?.last_output && (
          <div className="stat-card" style={{ gridColumn: '1 / -1' }}>
            <div className="stat-label">Last Claude output</div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>
              {progress.last_output}
            </div>
          </div>
        )}

        {status?.exit_reason && (
          <div className="stat-card" style={{ gridColumn: '1 / -1' }}>
            <div className="stat-label">Exit reason</div>
            <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 13, color: 'var(--yellow)' }}>
              {status.exit_reason}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
