import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useToast } from '../components/Toast'

const sb = window.slashbot

const SESSION_KEY_SEARCH = 'logviewer-search'
const SESSION_KEY_LEVELS = 'logviewer-levels'

type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'ALL'

const ALL_LEVELS: LogLevel[] = ['ALL', 'ERROR', 'WARN', 'INFO']

function getLineLevel(line: string): 'ERROR' | 'WARN' | 'INFO' {
  if (line.includes('[ERROR]') || line.includes('[FATAL]')) return 'ERROR'
  if (line.includes('[WARN]')) return 'WARN'
  return 'INFO'
}

function loadSessionLevels(): Set<LogLevel> {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY_LEVELS)
    if (stored) {
      const parsed = JSON.parse(stored) as LogLevel[]
      if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed)
    }
  } catch { /* ignore */ }
  return new Set<LogLevel>(['ALL'])
}

interface Props { projectPath: string }

export default function LogViewer({ projectPath }: Props) {
  const { showToast } = useToast()
  const [lines, setLines] = useState<string[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [searchInput, setSearchInput] = useState(() => sessionStorage.getItem(SESSION_KEY_SEARCH) || '')
  const [debouncedSearch, setDebouncedSearch] = useState(searchInput)
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(loadSessionLevels)
  const endRef = useRef<HTMLDivElement>(null)

  // Debounce search input (200ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 200)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Persist search to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY_SEARCH, searchInput)
  }, [searchInput])

  // Persist levels to sessionStorage
  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY_LEVELS, JSON.stringify([...activeLevels]))
  }, [activeLevels])

  useEffect(() => {
    sb.readLogs(projectPath, 500).then(setLines).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : 'Failed to read logs', { variant: 'error' })
    })
    const unsub = sb.onLogLines((_p: string, newLines: string[]) => {
      setLines(prev => [...prev.slice(-1000), ...newLines])
    })
    return unsub
  }, [projectPath])

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, autoScroll])

  const handleLevelToggle = useCallback((level: LogLevel) => {
    setActiveLevels(prev => {
      const next = new Set(prev)
      if (level === 'ALL') {
        // Toggle ALL: if ALL is active, keep it; if not, set to ALL only
        return new Set<LogLevel>(['ALL'])
      }
      // Remove ALL when toggling individual levels
      next.delete('ALL')
      if (next.has(level)) {
        next.delete(level)
      } else {
        next.add(level)
      }
      // If nothing selected or all three selected, revert to ALL
      if (next.size === 0 || next.size === 3) return new Set<LogLevel>(['ALL'])
      return next
    })
  }, [])

  const levelClass = (line: string) => {
    if (line.includes('[ERROR]') || line.includes('[FATAL]')) return 'log-error'
    if (line.includes('[WARN]')) return 'log-warn'
    if (line.includes('[SUCCESS]')) return 'log-success'
    return 'log-info'
  }

  const searchLower = debouncedSearch.toLowerCase()
  const showAll = activeLevels.has('ALL')

  const filteredLines = useMemo(() => {
    return lines.map((line, index) => {
      // Level filter
      if (!showAll) {
        const lineLevel = getLineLevel(line)
        if (!activeLevels.has(lineLevel)) return null
      }
      // Search filter
      if (searchLower && !line.toLowerCase().includes(searchLower)) return null
      return { line, index }
    }).filter(Boolean) as { line: string; index: number }[]
  }, [lines, showAll, activeLevels, searchLower])

  const highlightMatch = useCallback((text: string): React.ReactNode => {
    if (!searchLower) return text
    const lower = text.toLowerCase()
    const idx = lower.indexOf(searchLower)
    if (idx === -1) return text
    // Highlight all occurrences
    const parts: React.ReactNode[] = []
    let lastEnd = 0
    let pos = idx
    let key = 0
    while (pos !== -1) {
      if (pos > lastEnd) parts.push(text.slice(lastEnd, pos))
      parts.push(<mark key={key++} className="log-search-highlight">{text.slice(pos, pos + searchLower.length)}</mark>)
      lastEnd = pos + searchLower.length
      pos = lower.indexOf(searchLower, lastEnd)
    }
    if (lastEnd < text.length) parts.push(text.slice(lastEnd))
    return parts
  }, [searchLower])

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
      <div className="log-toolbar">
        <input
          type="text"
          className="log-search-input"
          placeholder="Search logs…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
        />
        <div className="log-level-filters">
          {ALL_LEVELS.map(level => (
            <label key={level} className={`log-level-chip ${activeLevels.has(level) ? 'active' : ''} level-${level.toLowerCase()}`}>
              <input
                type="checkbox"
                checked={activeLevels.has(level)}
                onChange={() => handleLevelToggle(level)}
              />
              {level}
            </label>
          ))}
        </div>
        {debouncedSearch && (
          <span className="log-match-count">{filteredLines.length} match{filteredLines.length !== 1 ? 'es' : ''}</span>
        )}
      </div>
      <div className="log-container">
        {filteredLines.map(({ line, index }) => (
          <div key={index} className={`log-line ${levelClass(line)}`}>{highlightMatch(line)}</div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
