import React, { useState, useEffect, useRef } from 'react'

const sb = window.slashbot

interface Props { projectPath: string }

export default function LogViewer({ projectPath }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    sb.readLogs(projectPath, 500).then(setLines)
    const unsub = sb.onLogLines((_p: string, newLines: string[]) => {
      setLines(prev => [...prev.slice(-1000), ...newLines])
    })
    return unsub
  }, [projectPath])

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, autoScroll])

  const levelClass = (line: string) => {
    if (line.includes('[ERROR]') || line.includes('[FATAL]')) return 'log-error'
    if (line.includes('[WARN]')) return 'log-warn'
    if (line.includes('[SUCCESS]')) return 'log-success'
    return 'log-info'
  }

  return (
    <div className="page">
      <header className="page-header">
        <h2>Logs</h2>
        <div className="header-actions">
          <label className="toggle-label">
            <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <button className="btn btn-ghost" onClick={() => setLines([])}>Clear</button>
        </div>
      </header>
      <div className="log-container">
        {lines.map((line, i) => (
          <div key={i} className={`log-line ${levelClass(line)}`}>{line}</div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
