import React, { useCallback, useEffect, useRef, useState } from 'react'

type Line = { raw: string; level: string; ts: string; msg: string }

const LEVEL_RE = /\[(SUCCESS|INFO|WARN|ERROR)\]/
const LEVEL_COLOR: Record<string, string> = {
  SUCCESS: 'var(--green)',
  INFO:    'var(--blue)',
  WARN:    'var(--yellow)',
  ERROR:   'var(--red)'
}

function parseLine(raw: string): Line {
  const levelMatch = raw.match(LEVEL_RE)
  const level = levelMatch ? levelMatch[1] : 'INFO'
  // [2026-03-19 12:00:00] [LEVEL] message
  const msg = raw.replace(/^\[[\d\s:-]+\]\s*\[(?:SUCCESS|INFO|WARN|ERROR)\]\s*/, '')
  const tsMatch = raw.match(/^\[([^\]]+)\]/)
  const ts = tsMatch ? tsMatch[1] : ''
  return { raw, level, ts, msg }
}

export default function LogViewer({ projectPath }: { projectPath: string | null }): JSX.Element {
  const [lines, setLines] = useState<Line[]>([])
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<string>('ALL')
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!projectPath) return
    setLoading(true)
    const raw = await window.ralph.readLogs(projectPath, 500)
    setLines(raw.map(parseLine))
    setLoading(false)
  }, [projectPath])

  useEffect(() => {
    load()
    if (!projectPath) return

    window.ralph.subscribeStatus(projectPath)
    const unsub = window.ralph.onLogLines(newLines => {
      setLines(prev => [...prev, ...newLines.map(parseLine)].slice(-2000))
    })
    return () => { unsub(); window.ralph.unsubscribeStatus() }
  }, [projectPath, load])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, autoScroll])

  const visible = lines.filter(l => {
    if (levelFilter !== 'ALL' && l.level !== levelFilter) return false
    if (filter && !l.raw.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  if (!projectPath) {
    return (
      <div className="state-box" style={{ flex: 1 }}>
        <div className="state-icon">≡</div>
        <div className="state-title">No project open</div>
      </div>
    )
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">≡ Log Viewer</div>
          <div className="page-sub">.ralph/logs/ralph.log — {lines.length} lines loaded</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '↻'} Reload
          </button>
          <button
            className={`btn btn-sm ${autoScroll ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setAutoScroll(a => !a)}
          >
            {autoScroll ? '⬇ Auto-scroll on' : '⬇ Auto-scroll off'}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="filter-bar" style={{ gap: 8, alignItems: 'center' }}>
        {['ALL', 'INFO', 'SUCCESS', 'WARN', 'ERROR'].map(l => (
          <button
            key={l}
            className={`filter-tab${levelFilter === l ? ' active' : ''}`}
            onClick={() => setLevelFilter(l)}
            style={l !== 'ALL' && levelFilter !== l ? { color: LEVEL_COLOR[l] } : undefined}
          >
            {l}
          </button>
        ))}
        <input
          type="search"
          placeholder="Filter lines…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            marginLeft: 'auto', padding: '5px 10px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--surface2)',
            color: 'var(--text)', fontSize: 12, outline: 'none', width: 220
          }}
        />
      </div>

      {/* Log lines */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '8px 0',
        fontFamily: 'monospace', fontSize: 12
      }}>
        {loading && lines.length === 0 ? (
          <div className="state-box"><span className="spinner" /></div>
        ) : visible.length === 0 ? (
          <div className="state-box">
            <div className="state-icon">✓</div>
            <div className="state-desc">{filter || levelFilter !== 'ALL' ? 'No matching lines' : 'Log is empty'}</div>
          </div>
        ) : (
          visible.map((line, i) => (
            <div key={i} style={{
              padding: '2px 24px', lineHeight: 1.6,
              borderLeft: `3px solid transparent`,
              borderLeftColor: LEVEL_COLOR[line.level] ?? 'transparent',
              marginBottom: 1
            }}>
              <span style={{ color: 'var(--muted)', marginRight: 8 }}>{line.ts}</span>
              <span style={{ color: LEVEL_COLOR[line.level] ?? 'var(--muted)', fontWeight: 700, marginRight: 8 }}>
                [{line.level}]
              </span>
              <span style={{ color: 'var(--text)' }}>{line.msg}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="summary-bar">
        Showing {visible.length} of {lines.length} lines
        {levelFilter !== 'ALL' && ` · filtered to ${levelFilter}`}
        {filter && ` · search: "${filter}"`}
      </div>
    </>
  )
}
