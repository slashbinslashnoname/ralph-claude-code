import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function TerminalPage({ projectPath }: { projectPath: string | null }): JSX.Element {
  const containerRef  = useRef<HTMLDivElement>(null)
  const termRef       = useRef<Terminal | null>(null)
  const fitAddonRef   = useRef<FitAddon | null>(null)
  const [running, setRunning]   = useState(false)
  const [starting, setStarting] = useState(false)

  // Mount xterm once
  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const term = new Terminal({
      theme: {
        background: '#0f1117',
        foreground: '#e2e8f0',
        cursor: '#6366f1',
        selectionBackground: '#6366f133'
      },
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    term.onData(data => window.ralph.ptyWrite(data))

    termRef.current  = term
    fitAddonRef.current = fit

    // Receive PTY output
    const unsubData = window.ralph.onPtyData(data => term.write(data))

    // Resize observer
    const ro = new ResizeObserver(() => {
      fit.fit()
      window.ralph.ptyResize(term.cols, term.rows)
    })
    ro.observe(containerRef.current)

    const unsubExit = window.ralph.onRalphExit(() => {
      setRunning(false)
      term.writeln('\r\n\x1b[33m[Ralph process exited]\x1b[0m')
    })

    return () => {
      unsubData()
      unsubExit()
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [])

  const handleStart = async (): Promise<void> => {
    if (!projectPath) return
    setStarting(true)
    termRef.current?.clear()
    const r = await window.ralph.startRalph(projectPath)
    setStarting(false)
    if (r.ok) {
      setRunning(true)
    } else {
      termRef.current?.writeln(`\r\n\x1b[31mFailed to start: ${r.error}\x1b[0m`)
    }
  }

  const handleStop = async (): Promise<void> => {
    await window.ralph.stopRalph()
    setRunning(false)
  }

  if (!projectPath) {
    return (
      <div className="state-box" style={{ flex: 1 }}>
        <div className="state-icon">⌨</div>
        <div className="state-title">No project open</div>
        <div className="state-desc">Select a project to launch a Ralph terminal.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <div>
          <div className="page-title">⌨ Terminal</div>
          <div className="page-sub">Interactive ralph_loop.sh session</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => termRef.current?.clear()}>
            Clear
          </button>
          {running
            ? <button className="btn btn-sm" style={{ background: 'var(--red)', color: '#fff' }} onClick={handleStop}>■ Stop</button>
            : <button className="btn btn-primary btn-sm" onClick={handleStart} disabled={starting}>
                {starting ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '▶'} Start Ralph
              </button>
          }
        </div>
      </div>

      <div
        ref={containerRef}
        style={{ flex: 1, padding: '8px', background: '#0f1117', overflow: 'hidden' }}
      />
    </div>
  )
}
