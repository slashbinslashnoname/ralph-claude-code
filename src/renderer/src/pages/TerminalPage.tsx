/**
 * TerminalPage — shows the live Claude output stream from RalphLoop.
 *
 * The loop runs natively in TS; its stdout is forwarded via pty:data IPC.
 * xterm.js renders the ANSI-colored output exactly as Claude emits it.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  projectPath: string
  onRunningChange: (running: boolean) => void
}

export default function TerminalPage({ projectPath, onRunningChange }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const [running, setRunning]   = useState(false)
  const [starting, setStarting] = useState(false)

  const setRunState = (r: boolean): void => { setRunning(r); onRunningChange(r) }

  // Mount terminal once per projectPath
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: {
        background: '#0f1117', foreground: '#e2e8f0',
        cursor: '#6366f1', selectionBackground: '#6366f133'
      },
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      fontSize: 13, lineHeight: 1.4, cursorBlink: true, scrollback: 10_000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current  = fit

    // Receive loop output forwarded from main
    const unsubData = window.ralph.onPtyData((p, chunk) => {
      if (p === projectPath) term.write(chunk)
    })

    const unsubExit = window.ralph.onRalphExit((p, reason, detail) => {
      if (p !== projectPath) return
      setRunState(false)
      term.writeln(`\r\n\x1b[33m[Ralph exited: ${reason}${detail ? ` — ${detail}` : ''}]\x1b[0m`)
    })

    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    // Check initial running state
    window.ralph.ralphRunning(projectPath).then(r => setRunState(r))

    return () => {
      unsubData(); unsubExit(); ro.disconnect(); term.dispose()
      termRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    termRef.current?.clear()
    termRef.current?.writeln('\x1b[36m[Starting Ralph loop...]\x1b[0m\r\n')
    const r = await window.ralph.startRalph(projectPath)
    setStarting(false)
    if (r.ok) setRunState(true)
    else termRef.current?.writeln(`\r\n\x1b[31mFailed: ${r.error}\x1b[0m`)
  }

  const handleStop = async (): Promise<void> => {
    await window.ralph.stopRalph(projectPath)
    setRunState(false)
    termRef.current?.writeln('\r\n\x1b[33m[Stopped by user]\x1b[0m')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="page-header">
        <div>
          <div className="page-title">⌨ Terminal</div>
          <div className="page-sub">Live output from the TypeScript loop engine</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => termRef.current?.clear()}>Clear</button>
          {running
            ? <button className="btn btn-sm" style={{ background: 'var(--red)', color: '#fff' }} onClick={handleStop}>■ Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={handleStart} disabled={starting}>
                {starting ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '▶'} Start Ralph
              </button>
          }
        </div>
      </div>

      <div ref={containerRef} style={{ flex: 1, padding: 8, background: '#0f1117', overflow: 'hidden' }} />
    </div>
  )
}
