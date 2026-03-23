import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MailMessage } from '../types/ipc'

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const mockList = vi.fn().mockResolvedValue([])
  const mockSubscribe = vi.fn().mockResolvedValue(undefined)
  const mockUnsubscribe = vi.fn().mockResolvedValue(undefined)
  const mockOnMessage = vi.fn().mockReturnValue(() => {})

  ;(globalThis as any).window = {
    slashbot: {
      mail: {
        list: mockList,
        subscribe: mockSubscribe,
        unsubscribe: mockUnsubscribe,
        onMessage: mockOnMessage,
      },
    },
  }

  return { mockList, mockSubscribe, mockUnsubscribe, mockOnMessage }
})

import MailPage, { groupThreads, agentColor, relativeTime } from './MailPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockList.mockResolvedValue([])
  mocks.mockOnMessage.mockReturnValue(() => {})
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMsg(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    ts: new Date().toISOString(),
    from: 'agent-0',
    to: 'agent-1',
    subject: 'Test subject',
    body: 'Test body content',
    threadId: 'thread-1',
    read: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Component render tests (SSR)
// ---------------------------------------------------------------------------
describe('MailPage (render)', () => {
  test('renders page with Mail heading and correct class', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/test/project" />)
    expect(html).toContain('Mail')
    expect(html).toContain('mail-page')
    expect(html).toContain('class="page mail-page"')
  })

  test('renders filter bar with All/Unread toggle', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toContain('mail-filter-bar')
    expect(html).toContain('>All<')
    expect(html).toContain('>Unread<')
  })

  test('All filter is active by default', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toMatch(/mail-toggle-btn active[^"]*">All/)
  })

  test('renders agent selector dropdown', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toContain('mail-agent-select')
    expect(html).toContain('All agents')
  })

  test('renders search input', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toContain('mail-search')
    expect(html).toContain('Search messages')
  })

  test('renders two-pane layout with thread list and detail', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toContain('mail-body')
    expect(html).toContain('mail-thread-list')
    expect(html).toContain('mail-detail')
  })

  test('renders empty state for both panes', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toContain('No messages')
    expect(html).toContain('Select a thread to view messages')
  })

  test('shows 0 messages count', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).toContain('0 messages')
  })

  test('renders without crashing for edge-case paths', () => {
    expect(() => renderToStaticMarkup(<MailPage projectPath="" />)).not.toThrow()
    expect(() => renderToStaticMarkup(<MailPage projectPath="/" />)).not.toThrow()
    expect(() => renderToStaticMarkup(<MailPage projectPath="/a/b/c/d" />)).not.toThrow()
  })

  test('does not show live dot initially (subscribe not yet resolved)', () => {
    const html = renderToStaticMarkup(<MailPage projectPath="/foo" />)
    expect(html).not.toContain('mail-live-dot')
  })
})

// ---------------------------------------------------------------------------
// groupThreads logic tests
// ---------------------------------------------------------------------------
describe('groupThreads', () => {
  test('groups messages by threadId', () => {
    const msgs = [
      makeMsg({ threadId: 't1', ts: '2026-01-01T00:00:00Z' }),
      makeMsg({ threadId: 't2', ts: '2026-01-01T00:01:00Z' }),
      makeMsg({ threadId: 't1', ts: '2026-01-01T00:02:00Z' }),
    ]
    const threads = groupThreads(msgs)
    expect(threads.length).toBe(2)
  })

  test('sorts threads newest-first by latest message', () => {
    const msgs = [
      makeMsg({ threadId: 't-old', ts: '2026-01-01T00:00:00Z', subject: 'Old' }),
      makeMsg({ threadId: 't-new', ts: '2026-03-01T00:00:00Z', subject: 'New' }),
    ]
    const threads = groupThreads(msgs)
    expect(threads[0].threadId).toBe('t-new')
    expect(threads[1].threadId).toBe('t-old')
  })

  test('messages within thread are sorted oldest-first (chronological)', () => {
    const msgs = [
      makeMsg({ threadId: 't1', body: 'Third', ts: '2026-01-01T00:03:00Z' }),
      makeMsg({ threadId: 't1', body: 'First', ts: '2026-01-01T00:01:00Z' }),
      makeMsg({ threadId: 't1', body: 'Second', ts: '2026-01-01T00:02:00Z' }),
    ]
    const threads = groupThreads(msgs)
    expect(threads[0].messages[0].body).toBe('First')
    expect(threads[0].messages[1].body).toBe('Second')
    expect(threads[0].messages[2].body).toBe('Third')
  })

  test('latest is the most recent message in thread', () => {
    const msgs = [
      makeMsg({ threadId: 't1', subject: 'Early', ts: '2026-01-01T00:00:00Z' }),
      makeMsg({ threadId: 't1', subject: 'Latest', ts: '2026-01-01T01:00:00Z' }),
    ]
    const threads = groupThreads(msgs)
    expect(threads[0].latest.subject).toBe('Latest')
  })

  test('hasUnread is true when any message is unread', () => {
    const msgs = [
      makeMsg({ threadId: 't1', read: true, ts: '2026-01-01T00:00:00Z' }),
      makeMsg({ threadId: 't1', read: false, ts: '2026-01-01T00:01:00Z' }),
    ]
    const threads = groupThreads(msgs)
    expect(threads[0].hasUnread).toBe(true)
  })

  test('hasUnread is false when all messages are read', () => {
    const msgs = [
      makeMsg({ threadId: 't1', read: true, ts: '2026-01-01T00:00:00Z' }),
      makeMsg({ threadId: 't1', read: true, ts: '2026-01-01T00:01:00Z' }),
    ]
    const threads = groupThreads(msgs)
    expect(threads[0].hasUnread).toBe(false)
  })

  test('returns empty array for empty input', () => {
    expect(groupThreads([])).toEqual([])
  })

  test('single message produces thread with 1 message', () => {
    const threads = groupThreads([makeMsg({ threadId: 't1' })])
    expect(threads.length).toBe(1)
    expect(threads[0].messages.length).toBe(1)
    expect(threads[0].latest).toBe(threads[0].messages[0])
  })
})

// ---------------------------------------------------------------------------
// agentColor tests
// ---------------------------------------------------------------------------
describe('agentColor', () => {
  test('returns a hex color string', () => {
    expect(agentColor('agent-0')).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test('is deterministic (same name → same color)', () => {
    expect(agentColor('agent-0')).toBe(agentColor('agent-0'))
  })

  test('different names can produce different colors', () => {
    // At least some of these should differ
    const colors = new Set(['a', 'b', 'c', 'd', 'e'].map(agentColor))
    expect(colors.size).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// relativeTime tests
// ---------------------------------------------------------------------------
describe('relativeTime', () => {
  test('returns "just now" for timestamps less than a minute ago', () => {
    const ts = new Date(Date.now() - 30_000).toISOString()
    expect(relativeTime(ts)).toBe('just now')
  })

  test('returns minutes ago', () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(relativeTime(ts)).toBe('5m ago')
  })

  test('returns hours ago', () => {
    const ts = new Date(Date.now() - 3 * 3_600_000).toISOString()
    expect(relativeTime(ts)).toBe('3h ago')
  })

  test('returns days ago', () => {
    const ts = new Date(Date.now() - 2 * 86_400_000).toISOString()
    expect(relativeTime(ts)).toBe('2d ago')
  })
})

// ---------------------------------------------------------------------------
// API contract tests (ensures component calls correct methods)
// ---------------------------------------------------------------------------
describe('MailPage (API contract)', () => {
  test('window.slashbot.mail has all required methods', () => {
    const mail = window.slashbot.mail
    expect(typeof mail.list).toBe('function')
    expect(typeof mail.subscribe).toBe('function')
    expect(typeof mail.unsubscribe).toBe('function')
    expect(typeof mail.onMessage).toBe('function')
  })

  test('onMessage returns a cleanup function', () => {
    const cleanup = window.slashbot.mail.onMessage(() => {})
    expect(typeof cleanup).toBe('function')
  })
})
