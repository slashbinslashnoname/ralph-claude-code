import React, { useState, useMemo } from 'react'

// ── Claude result JSON parser & renderer ────────────────────────────────────

interface ClaudeResult {
  type: 'result'
  subtype: string
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  result: string
  stop_reason: string
  session_id: string
  total_cost_usd: number
  usage: any
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number
  }>
}

type OutputSegment =
  | { kind: 'text'; text: string }
  | { kind: 'result'; data: ClaudeResult }

/** Find the end of a JSON object starting at `start`, handling strings correctly */
function findJsonEnd(raw: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return -1 // incomplete
}

function parseOutputSegments(raw: string): OutputSegment[] {
  const segments: OutputSegment[] = []
  const marker = '{"type":"result"'
  let pos = 0

  while (pos < raw.length) {
    const idx = raw.indexOf(marker, pos)
    if (idx < 0) {
      segments.push({ kind: 'text', text: raw.slice(pos) })
      break
    }

    if (idx > pos) {
      segments.push({ kind: 'text', text: raw.slice(pos, idx) })
    }

    const end = findJsonEnd(raw, idx)
    if (end < 0) {
      segments.push({ kind: 'text', text: raw.slice(idx) })
      break
    }

    const jsonStr = raw.slice(idx, end)
    try {
      const parsed = JSON.parse(jsonStr)
      if (parsed.type === 'result') {
        segments.push({ kind: 'result', data: parsed })
      } else {
        segments.push({ kind: 'text', text: jsonStr })
      }
    } catch {
      segments.push({ kind: 'text', text: jsonStr })
    }
    pos = end
  }
  return segments
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}c`
  return `$${usd.toFixed(4)}`
}

/** Render simple markdown: headings, bold, code, lists */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let inList = false
  let listItems: React.ReactNode[] = []

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(<ul key={`list-${nodes.length}`} className="cr-list">{listItems}</ul>)
      listItems = []
      inList = false
    }
  }

  const inlineFormat = (line: string, key: string): React.ReactNode => {
    const parts: React.ReactNode[] = []
    const re = /(\*\*(.+?)\*\*|`([^`]+)`)/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push(line.slice(last, m.index))
      if (m[2]) parts.push(<strong key={`${key}-b-${m.index}`}>{m[2]}</strong>)
      if (m[3]) parts.push(<code key={`${key}-c-${m.index}`} className="cr-inline-code">{m[3]}</code>)
      last = m.index + m[0].length
    }
    if (last < line.length) parts.push(line.slice(last))
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/)
    if (hMatch) {
      flushList()
      const level = hMatch[1].length
      const Tag = `h${Math.min(level + 2, 6)}` as keyof React.JSX.IntrinsicElements
      nodes.push(<Tag key={`h-${i}`} className="cr-heading">{inlineFormat(hMatch[2], `h-${i}`)}</Tag>)
      continue
    }

    if (/^---+$/.test(trimmed)) {
      flushList()
      nodes.push(<hr key={`hr-${i}`} className="cr-hr" />)
      continue
    }

    const liMatch = trimmed.match(/^(\d+\.|[-*])\s+(.+)/)
    if (liMatch) {
      inList = true
      listItems.push(<li key={`li-${i}`}>{inlineFormat(liMatch[2], `li-${i}`)}</li>)
      continue
    }

    if (!trimmed) {
      flushList()
      continue
    }

    flushList()
    nodes.push(<p key={`p-${i}`} className="cr-para">{inlineFormat(trimmed, `p-${i}`)}</p>)
  }
  flushList()
  return nodes
}

function ClaudeResultCard({ data }: { data: ClaudeResult }) {
  const [expanded, setExpanded] = useState(false)
  const isSuccess = data.subtype === 'success' && !data.is_error

  const models = Object.entries(data.modelUsage ?? {})
  const totalTokensIn = models.reduce((s, [, m]) =>
    s + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0)
  const totalTokensOut = models.reduce((s, [, m]) => s + (m.outputTokens ?? 0), 0)

  return (
    <div className={`cr-card ${isSuccess ? 'cr-success' : 'cr-error'}`}>
      <div className="cr-header" onClick={() => setExpanded(!expanded)}>
        <span className={`cr-status-icon ${isSuccess ? 'cr-icon-ok' : 'cr-icon-err'}`}>
          {isSuccess ? '\u2713' : '\u2717'}
        </span>
        <span className="cr-title">
          Claude {isSuccess ? 'completed' : 'failed'}
        </span>
        <div className="cr-stats">
          <span className="cr-stat">{formatDuration(data.duration_ms)}</span>
          <span className="cr-stat-sep">/</span>
          <span className="cr-stat">{data.num_turns} turns</span>
          <span className="cr-stat-sep">/</span>
          <span className="cr-stat">{formatCost(data.total_cost_usd)}</span>
        </div>
        <span className={`cr-expand ${expanded ? 'cr-expanded' : ''}`}>{'\u25B6'}</span>
      </div>

      <div className="cr-token-bar">
        {models.map(([name, m]) => {
          const short = name.includes('opus') ? 'Opus' : name.includes('sonnet') ? 'Sonnet' : name.includes('haiku') ? 'Haiku' : name.split('/').pop()?.split('-')[0] ?? name
          return (
            <span key={name} className="cr-model-chip" title={name}>
              {short}: {((m.inputTokens + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0)) / 1000).toFixed(0)}k in / {(m.outputTokens / 1000).toFixed(1)}k out — {formatCost(m.costUSD)}
            </span>
          )
        })}
      </div>

      {expanded && (
        <div className="cr-body">
          <div className="cr-result-text">
            {renderMarkdown(data.result)}
          </div>
          <div className="cr-meta">
            <span>Session: <code>{data.session_id?.slice(0, 8)}</code></span>
            <span>Stop: {data.stop_reason}</span>
            <span>API time: {formatDuration(data.duration_api_ms)}</span>
            <span>Tokens: {(totalTokensIn / 1000).toFixed(0)}k in / {(totalTokensOut / 1000).toFixed(1)}k out</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default function AgentOutputRenderer({ output }: { output: string }) {
  const segments = useMemo(() => parseOutputSegments(output), [output])

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'result') {
          return <ClaudeResultCard key={`cr-${i}`} data={seg.data} />
        }
        const text = seg.text
        if (!text.trim()) return null
        return <span key={`t-${i}`}>{text}</span>
      })}
    </>
  )
}
