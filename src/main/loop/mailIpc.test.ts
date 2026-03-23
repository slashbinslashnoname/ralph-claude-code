import { describe, it, expect } from 'vitest'
import type { MailMessage } from '../types'

/**
 * Tests for the mail IPC handler logic.
 *
 * Since ipc.ts has Electron dependencies that prevent direct import,
 * we test the core logic (JSONL parsing, delta streaming, validation)
 * that the handlers are built on.
 */

// ── JSONL parsing (mirrors mail:list logic) ──────────────────────────────

function parseMailJsonl(text: string, limit: number): MailMessage[] {
  const lines = text.split('\n').filter(Boolean)
  const messages: MailMessage[] = []
  for (const line of lines) {
    try { messages.push(JSON.parse(line) as MailMessage) } catch { /* skip */ }
  }
  return messages.slice(-limit)
}

const sampleMsg: MailMessage = {
  ts: '2026-03-23T10:00:00Z',
  from: 'agent-0',
  to: 'agent-1',
  subject: 'file lock request',
  body: 'Need src/main.ts',
  threadId: 'thread-1',
  read: false,
}

describe('parseMailJsonl', () => {
  it('parses valid JSONL', () => {
    const text = JSON.stringify(sampleMsg) + '\n'
    const result = parseMailJsonl(text, 50)
    expect(result).toHaveLength(1)
    expect(result[0].from).toBe('agent-0')
  })

  it('skips malformed lines', () => {
    const text = JSON.stringify(sampleMsg) + '\n' + 'not json\n' + JSON.stringify({ ...sampleMsg, from: 'agent-2' }) + '\n'
    const result = parseMailJsonl(text, 50)
    expect(result).toHaveLength(2)
    expect(result[0].from).toBe('agent-0')
    expect(result[1].from).toBe('agent-2')
  })

  it('respects limit (returns last N messages)', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ ...sampleMsg, from: `agent-${i}` })
    ).join('\n')
    const result = parseMailJsonl(lines, 3)
    expect(result).toHaveLength(3)
    expect(result[0].from).toBe('agent-7')
    expect(result[2].from).toBe('agent-9')
  })

  it('handles empty text', () => {
    expect(parseMailJsonl('', 50)).toEqual([])
  })

  it('handles text with only newlines', () => {
    expect(parseMailJsonl('\n\n\n', 50)).toEqual([])
  })
})

// ── Delta streaming (mirrors mail:subscribe logic) ────────────────────────

function extractNewMessages(text: string, prevSize: number): { messages: MailMessage[]; newSize: number } {
  const newContent = text.slice(prevSize)
  const messages: MailMessage[] = []
  if (newContent) {
    const lines = newContent.split('\n').filter(Boolean)
    for (const line of lines) {
      try { messages.push(JSON.parse(line) as MailMessage) } catch { /* skip */ }
    }
  }
  return { messages, newSize: text.length }
}

describe('extractNewMessages (delta streaming)', () => {
  it('extracts only new messages after offset', () => {
    const initial = JSON.stringify(sampleMsg) + '\n'
    const newMsg = { ...sampleMsg, from: 'agent-3', subject: 'new' }
    const full = initial + JSON.stringify(newMsg) + '\n'

    const result = extractNewMessages(full, initial.length)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].from).toBe('agent-3')
    expect(result.newSize).toBe(full.length)
  })

  it('returns empty when no new content', () => {
    const text = JSON.stringify(sampleMsg) + '\n'
    const result = extractNewMessages(text, text.length)
    expect(result.messages).toEqual([])
  })

  it('handles multiple new messages at once', () => {
    const initial = JSON.stringify(sampleMsg) + '\n'
    const newLines = [
      JSON.stringify({ ...sampleMsg, from: 'agent-1' }),
      JSON.stringify({ ...sampleMsg, from: 'agent-2' }),
    ].join('\n') + '\n'
    const full = initial + newLines

    const result = extractNewMessages(full, initial.length)
    expect(result.messages).toHaveLength(2)
  })

  it('skips malformed new lines', () => {
    const initial = ''
    const full = 'garbage\n' + JSON.stringify(sampleMsg) + '\n'
    const result = extractNewMessages(full, initial.length)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].from).toBe('agent-0')
  })
})
