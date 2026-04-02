import React, { useState, useMemo } from 'react'

// ── Claude stream-json + result parser & renderer ──────────────────────────

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
  usage?: Record<string, unknown>
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
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; name: string; input: string }
  | { kind: 'tool_result'; content: string; is_error?: boolean }
  | { kind: 'system'; message: string }

function parseOutputSegments(raw: string): OutputSegment[] {
  const segments: OutputSegment[] = []
  const lines = raw.split('\n')
  let textBuf: string[] = []

  const flushText = () => {
    if (textBuf.length > 0) {
      const t = textBuf.join('\n')
      if (t.trim()) segments.push({ kind: 'text', text: t })
      textBuf = []
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) { textBuf.push(''); continue }
    if (!trimmed.startsWith('{')) { textBuf.push(line); continue }

    try {
      const obj = JSON.parse(trimmed)

      if (obj.type === 'result') {
        flushText()
        segments.push({ kind: 'result', data: obj })
        continue
      }

      if (obj.type === 'assistant') {
        const parts: string[] = []
        if (typeof obj.message === 'string') {
          parts.push(obj.message)
        } else if (obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text) parts.push(block.text)
            if (block.type === 'tool_use') {
              flushText()
              if (parts.length > 0) {
                segments.push({ kind: 'assistant', text: parts.join('\n') })
                parts.length = 0
              }
              const inputStr = typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input, null, 2)
              segments.push({ kind: 'tool_use', name: block.name ?? 'tool', input: inputStr })
            }
          }
        }
        if (parts.length > 0) {
          flushText()
          segments.push({ kind: 'assistant', text: parts.join('\n') })
        }
        continue
      }

      if (obj.type === 'tool_use') {
        flushText()
        const inputStr = typeof obj.input === 'string'
          ? obj.input
          : JSON.stringify(obj.input ?? obj.tool?.input ?? {}, null, 2)
        segments.push({ kind: 'tool_use', name: obj.name ?? obj.tool?.name ?? 'tool', input: inputStr })
        continue
      }

      if (obj.type === 'tool_result') {
        flushText()
        const content = typeof obj.content === 'string'
          ? obj.content
          : typeof obj.tool_result === 'string'
            ? obj.tool_result
            : JSON.stringify(obj.content ?? obj.tool_result ?? '', null, 2)
        segments.push({ kind: 'tool_result', content, is_error: obj.is_error })
        continue
      }

      if (obj.type === 'system') {
        flushText()
        const msg = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj)
        segments.push({ kind: 'system', message: msg })
        continue
      }

      // user messages contain tool_result content being sent back to Claude
      if (obj.type === 'user') {
        const content = obj.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              flushText()
              const resultContent = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: { text?: string }) => c.text ?? '').join('\n')
                  : JSON.stringify(block.content ?? '', null, 2)
              if (resultContent.trim()) {
                segments.push({ kind: 'tool_result', content: resultContent, is_error: block.is_error })
              }
            }
          }
        }
        continue
      }

      // Skip known noise events silently (don't render as raw text)
      if (['message_start', 'message_delta', 'message_stop',
           'content_block_start', 'content_block_delta', 'content_block_stop',
           'ping', 'error'].includes(obj.type)) {
        continue
      }

      // Unknown JSON — skip silently to avoid raw JSON noise
      continue
    } catch {
      textBuf.push(line)
    }
  }

  flushText()

  // Merge consecutive assistant segments
  const merged: OutputSegment[] = []
  for (const seg of segments) {
    const prev = merged[merged.length - 1]
    if (seg.kind === 'assistant' && prev?.kind === 'assistant') {
      (prev as { text: string }).text += '\n' + seg.text
    } else {
      merged.push(seg)
    }
  }

  return merged
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

/** Render simple markdown: headings, bold, code blocks, lists */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let inList = false
  let listItems: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []
  let codeLang = ''

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(<ul key={`list-${nodes.length}`} className="cr-list">{listItems}</ul>)
      listItems = []
      inList = false
    }
  }

  const flushCode = () => {
    if (codeLines.length > 0) {
      nodes.push(
        <pre key={`code-${nodes.length}`} className="cr-code-block">
          {codeLang && <span className="cr-code-lang">{codeLang}</span>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      codeLines = []
      codeLang = ''
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

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false
        flushCode()
      } else {
        flushList()
        inCodeBlock = true
        codeLang = trimmed.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

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
  flushCode()
  return nodes
}

/** Truncate tool input for collapsed view */
function truncateInput(input: string, max = 120): string {
  const oneLine = input.replace(/\n/g, ' ').replace(/\s+/g, ' ')
  return oneLine.length > max ? oneLine.slice(0, max) + '\u2026' : oneLine
}

function ToolUseBlock({ name, input }: { name: string; input: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = input.length > 150

  return (
    <div className="sj-tool-use">
      <div className="sj-tool-header" onClick={() => isLong && setExpanded(!expanded)}>
        <span className="sj-tool-icon">{'\u25B8'}</span>
        <span className="sj-tool-name">{name}</span>
        {!expanded && isLong && (
          <span className="sj-tool-preview">{truncateInput(input)}</span>
        )}
        {isLong && (
          <span className={`sj-tool-expand ${expanded ? 'sj-expanded' : ''}`}>{'\u25B6'}</span>
        )}
      </div>
      {(expanded || !isLong) && (
        <pre className="sj-tool-input"><code>{input}</code></pre>
      )}
    </div>
  )
}

function ToolResultBlock({ content, is_error }: { content: string; is_error?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = content.length > 300

  return (
    <div className={`sj-tool-result ${is_error ? 'sj-tool-error' : ''}`}>
      <div className="sj-result-header" onClick={() => isLong && setExpanded(!expanded)}>
        <span className="sj-result-icon">{is_error ? '\u2717' : '\u2190'}</span>
        <span className="sj-result-label">{is_error ? 'Error' : 'Result'}</span>
        {isLong && (
          <span className={`sj-tool-expand ${expanded ? 'sj-expanded' : ''}`}>{'\u25B6'}</span>
        )}
      </div>
      <pre className={`sj-result-content ${isLong && !expanded ? 'sj-truncated' : ''}`}>
        <code>{expanded || !isLong ? content : content.slice(0, 300) + '\u2026'}</code>
      </pre>
    </div>
  )
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
    <div className="sj-output">
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'result':
            return <ClaudeResultCard key={`cr-${i}`} data={seg.data} />
          case 'assistant':
            return (
              <div key={`ast-${i}`} className="sj-assistant">
                {renderMarkdown(seg.text)}
              </div>
            )
          case 'tool_use':
            return <ToolUseBlock key={`tu-${i}`} name={seg.name} input={seg.input} />
          case 'tool_result':
            return <ToolResultBlock key={`tr-${i}`} content={seg.content} is_error={seg.is_error} />
          case 'system':
            return (
              <div key={`sys-${i}`} className="sj-system">
                {seg.message}
              </div>
            )
          case 'text': {
            if (!seg.text.trim()) return null
            return <span key={`t-${i}`} className="sj-raw">{seg.text}</span>
          }
        }
      })}
    </div>
  )
}
