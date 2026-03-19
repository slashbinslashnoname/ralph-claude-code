/**
 * TerminalPage — live Claude output for all agents.
 *
 * A tab bar shows one terminal per active agent ("planner", "agent-0", etc.).
 * Each terminal is an xterm.js instance mounted once and kept alive as the
 * user switches tabs (hidden via display:none rather than unmounted).
 */
import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  projectPath: string
  onRunningChange: (running: boolean) => void
}

const TERM_THEME = {
  background: '#0f1117', foreground: '#e2e8f0',
  cursor: '#6366f1', selectionBackground: '#6366f133'
}
const TERM_OPTS = {
  theme: TERM_THEME,
  fontFamily: '"Cascadia Code", "Fira Code", monospace',
  fontSize: 13, lineHeight: 1.4, cursorBlink: true, scrollback: 10_000
}

/** One persistent xterm terminal per agent. */
function useAgentTerminal(
  containerRef: React.RefObject<HTMLDivElement>,
  active: boolean
) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef  = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current || termRef.current) return
    const term = new Terminal(TERM_OPTS)
    const fit  = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current  = fit
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); term.dispose(); termRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fit when the tab becomes visible
  useEffect(() => {
    if (active) setTimeout(() => fitRef.current?.fit(), 50)
  }, [active])

  return termRef
}

// ── Single agent terminal pane ─────────────────────────────────────────────

function AgentTerminal({
  agentId, active
}: { agentId: string; active: boolean }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  useAgentTerminal(containerRef, active)
  return (
    <div
      ref={containerRef}
      style={{
        flex: 1, padding: 8, background: '#0f1117', overflow: 'hidden',
        display: active ? 'block' : 'none'
      }}
    />
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function TerminalPage({ projectPath, onRunningChange }: Props): JSX.Element {
  // agentId → Terminal ref (managed in a map via state)
  const termRefs  = useRef<Map<string, React.RefObject<HTMLDivElement>>>(new Map())
  const xterms    = useRef<Map<string, Terminal>>(new Map())

  const [agents,   setAgents]   = useState<string[]>(['main'])  // default: legacy single-agent
  const [active,   setActive]   = useState('main')
  const [running,  setRunning]  = useState(false)
  const [starting, setStarting] = useState(false)

  const setRunState = (r: boolean): void => { setRunning(r); onRunningChange(r) }

  // Ensure a ref exists for each agentId
  const ensureRef = (id: string): React.RefObject<HTMLDivElement> => {
    if (!termRefs.current.has(id)) {
      termRefs.current.set(id, React.createRef<HTMLDivElement>())
    }
    return termRefs.current.get(id)!
  }

  // Mount xterm into a container div
  const mountTerminal = (id: string, container: HTMLDivElement): void => {
    if (xterms.current.has(id)) return
    const term = new Terminal(TERM_OPTS)
    const fit  = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    xterms.current.set(id, term)
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(container)
  }

  // ── Legacy ralph loop output (single agent) ──────────────────────────────
  useEffect(() => {
    const unsubData = window.ralph.onPtyData((p, chunk) => {
      if (p !== projectPath) return
      const term = xterms.current.get('main')
      if (term) term.write(chunk)
    })
    const unsubExit = window.ralph.onRalphExit((p, reason, detail) => {
      if (p !== projectPath) return
      setRunState(false)
      const term = xterms.current.get('main')
      term?.writeln(`\r\n\x1b[33m[Ralph exited: ${reason}${detail ? ` — ${detail}` : ''}]\x1b[0m`)
    })
    window.ralph.ralphRunning(projectPath).then(r => setRunState(r))
    return () => { unsubData(); unsubExit() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  // ── Swarm output routing (one tab per agent) ─────────────────────────────
  useEffect(() => {
    const unsubOutput = window.ralph.swarm.onOutput((p, agentId, chunk) => {
      if (p !== projectPath) return
      // Add tab if new agent
      setAgents(prev => prev.includes(agentId) ? prev : [...prev, agentId])
      const term = xterms.current.get(agentId)
      if (term) term.write(chunk)
    })

    const unsubAgents = window.ralph.swarm.onAgents((p, agentList) => {
      if (p !== projectPath) return
      const ids = (agentList as { id: string }[]).map(a => a.id)
      setAgents(prev => {
        const next = [...prev]
        for (const id of ids) if (!next.includes(id)) next.push(id)
        return next
      })
    })

    const unsubLog = window.ralph.swarm.onLog((p, _level, msg, agentId) => {
      if (p !== projectPath) return
      const tid = agentId ?? 'planner'
      setAgents(prev => prev.includes(tid) ? prev : [...prev, tid])
      const term = xterms.current.get(tid)
      if (term) term.writeln(`\r\n\x1b[2m${msg}\x1b[0m`)
    })

    const unsubStopped = window.ralph.swarm.onStopped((p) => {
      if (p !== projectPath) return
      setRunState(false)
    })

    return () => { unsubOutput(); unsubAgents(); unsubLog(); unsubStopped() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    xterms.current.get('main')?.clear()
    xterms.current.get('main')?.writeln('\x1b[36m[Starting Ralph loop...]\x1b[0m\r\n')
    const r = await window.ralph.startRalph(projectPath)
    setStarting(false)
    if (r.ok) setRunState(true)
    else xterms.current.get('main')?.writeln(`\r\n\x1b[31mFailed: ${r.error}\x1b[0m`)
  }

  const handleStop = async (): Promise<void> => {
    await window.ralph.stopRalph(projectPath)
    await window.ralph.swarm.stop(projectPath)
    setRunState(false)
    xterms.current.get('main')?.writeln('\r\n\x1b[33m[Stopped by user]\x1b[0m')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">⌨ Terminal</div>
          <div className="page-sub">Live output per agent</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => {
            xterms.current.get(active)?.clear()
          }}>Clear</button>
          {running
            ? <button className="btn btn-sm" style={{ background: 'var(--red)', color: '#fff' }} onClick={handleStop}>■ Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={handleStart} disabled={starting}>
                {starting ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '▶'} Start Ralph
              </button>
          }
        </div>
      </div>

      {/* Agent tab bar */}
      {agents.length > 1 && (
        <div style={{
          display: 'flex', gap: 2, padding: '4px 12px',
          background: 'var(--surface2)', borderBottom: '1px solid var(--border)',
          overflowX: 'auto'
        }}>
          {agents.map(id => (
            <button
              key={id}
              onClick={() => {
                setActive(id)
                setTimeout(() => {
                  const ref = termRefs.current.get(id)
                  if (ref?.current && !xterms.current.has(id)) {
                    mountTerminal(id, ref.current)
                  }
                }, 20)
              }}
              style={{
                padding: '3px 12px', fontSize: 11, borderRadius: 4, border: 'none',
                background: active === id ? 'var(--accent)' : 'transparent',
                color: active === id ? '#fff' : 'var(--muted)',
                cursor: 'pointer', fontFamily: 'monospace', whiteSpace: 'nowrap'
              }}
            >
              {id}
            </button>
          ))}
        </div>
      )}

      {/* Terminal panels — all mounted, only active is visible */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {agents.map(id => {
          const ref = ensureRef(id)
          return (
            <div
              key={id}
              ref={el => {
                // Mount terminal when div is first visible
                if (el && !xterms.current.has(id)) mountTerminal(id, el)
                // Store in ref map
                ;(ref as React.MutableRefObject<HTMLDivElement | null>).current = el
              }}
              style={{
                position: 'absolute', inset: 0,
                padding: 8, background: '#0f1117',
                visibility: id === active ? 'visible' : 'hidden',
                pointerEvents: id === active ? 'auto' : 'none'
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
