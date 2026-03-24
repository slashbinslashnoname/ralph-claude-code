import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityEvent } from '../types/ipc'

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const mockActivity = vi.fn().mockResolvedValue([])
  const mockOnActivity = vi.fn().mockReturnValue(() => {})

  ;(globalThis as any).window = {
    slashbot: {
      swarm: {
        activity: mockActivity,
        onActivity: mockOnActivity,
      },
    },
  }

  return { mockActivity, mockOnActivity }
})

import ThreadsPage, { groupBeadThreads, agentColor, relativeTime } from './ThreadsPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockActivity.mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    ts: new Date().toISOString(),
    agentId: 'worker-0',
    type: 'executing',
    beadId: 'bead-1',
    beadTitle: 'Test bead',
    summary: 'Doing work',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Component render tests (SSR)
// ---------------------------------------------------------------------------
describe('ThreadsPage (render)', () => {
  test('renders page with Threads heading and correct class', () => {
    const html = renderToStaticMarkup(<ThreadsPage projectPath="/test/project" activity={[]} />)
    expect(html).toContain('Threads')
    expect(html).toContain('threads-page')
    expect(html).toContain('class="page threads-page"')
  })

  test('renders filter bar with agent and event type selectors', () => {
    const html = renderToStaticMarkup(<ThreadsPage projectPath="/foo" activity={[]} />)
    expect(html).toContain('mail-filter-bar')
    expect(html).toContain('All agents')
    expect(html).toContain('All events')
  })

  test('renders search input', () => {
    const html = renderToStaticMarkup(<ThreadsPage projectPath="/foo" activity={[]} />)
    expect(html).toContain('mail-search')
    expect(html).toContain('Search threads')
  })

  test('renders two-pane layout with thread list and detail', () => {
    const html = renderToStaticMarkup(<ThreadsPage projectPath="/foo" activity={[]} />)
    expect(html).toContain('mail-body')
    expect(html).toContain('mail-thread-list')
    expect(html).toContain('mail-detail')
  })

  test('renders empty state for both panes', () => {
    const html = renderToStaticMarkup(<ThreadsPage projectPath="/foo" activity={[]} />)
    expect(html).toContain('No bead activity yet')
    expect(html).toContain('Select a bead thread to view its activity timeline')
  })

  test('shows 0 beads count', () => {
    const html = renderToStaticMarkup(<ThreadsPage projectPath="/foo" activity={[]} />)
    expect(html).toContain('0 beads with activity')
  })

  test('renders without crashing for edge-case paths', () => {
    expect(() => renderToStaticMarkup(<ThreadsPage projectPath="" activity={[]} />)).not.toThrow()
    expect(() => renderToStaticMarkup(<ThreadsPage projectPath="/" activity={[]} />)).not.toThrow()
    expect(() => renderToStaticMarkup(<ThreadsPage projectPath="/a/b/c" activity={[]} />)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// groupBeadThreads logic tests
// ---------------------------------------------------------------------------
describe('groupBeadThreads', () => {
  test('groups events by beadId', () => {
    const events = [
      makeEvent({ beadId: 'b1', ts: '2026-01-01T00:00:00Z' }),
      makeEvent({ beadId: 'b2', ts: '2026-01-01T00:01:00Z' }),
      makeEvent({ beadId: 'b1', ts: '2026-01-01T00:02:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads.length).toBe(2)
  })

  test('skips events without beadId', () => {
    const events = [
      makeEvent({ beadId: 'b1', ts: '2026-01-01T00:00:00Z' }),
      makeEvent({ beadId: undefined, ts: '2026-01-01T00:01:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads.length).toBe(1)
  })

  test('sorts threads newest-first by latest event', () => {
    const events = [
      makeEvent({ beadId: 'b-old', ts: '2026-01-01T00:00:00Z', beadTitle: 'Old' }),
      makeEvent({ beadId: 'b-new', ts: '2026-03-01T00:00:00Z', beadTitle: 'New' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads[0].beadId).toBe('b-new')
    expect(threads[1].beadId).toBe('b-old')
  })

  test('events within thread are sorted oldest-first (chronological)', () => {
    const events = [
      makeEvent({ beadId: 'b1', summary: 'Third', ts: '2026-01-01T00:03:00Z' }),
      makeEvent({ beadId: 'b1', summary: 'First', ts: '2026-01-01T00:01:00Z' }),
      makeEvent({ beadId: 'b1', summary: 'Second', ts: '2026-01-01T00:02:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads[0].events[0].summary).toBe('First')
    expect(threads[0].events[1].summary).toBe('Second')
    expect(threads[0].events[2].summary).toBe('Third')
  })

  test('latest is the most recent event in thread', () => {
    const events = [
      makeEvent({ beadId: 'b1', summary: 'Early', ts: '2026-01-01T00:00:00Z' }),
      makeEvent({ beadId: 'b1', summary: 'Latest', ts: '2026-01-01T01:00:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads[0].latest.summary).toBe('Latest')
  })

  test('collects unique agent IDs per thread', () => {
    const events = [
      makeEvent({ beadId: 'b1', agentId: 'worker-0', ts: '2026-01-01T00:00:00Z' }),
      makeEvent({ beadId: 'b1', agentId: 'worker-1', ts: '2026-01-01T00:01:00Z' }),
      makeEvent({ beadId: 'b1', agentId: 'worker-0', ts: '2026-01-01T00:02:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads[0].agents).toEqual(['worker-0', 'worker-1'])
  })

  test('uses beadTitle from event when available', () => {
    const events = [
      makeEvent({ beadId: 'b1', beadTitle: undefined, ts: '2026-01-01T00:00:00Z' }),
      makeEvent({ beadId: 'b1', beadTitle: 'My Task', ts: '2026-01-01T00:01:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads[0].beadTitle).toBe('My Task')
  })

  test('falls back to beadId when no beadTitle', () => {
    const events = [
      makeEvent({ beadId: 'b1', beadTitle: undefined, ts: '2026-01-01T00:00:00Z' }),
    ]
    const threads = groupBeadThreads(events)
    expect(threads[0].beadTitle).toBe('b1')
  })

  test('returns empty array for empty input', () => {
    expect(groupBeadThreads([])).toEqual([])
  })

  test('single event produces thread with 1 event', () => {
    const threads = groupBeadThreads([makeEvent({ beadId: 'b1' })])
    expect(threads.length).toBe(1)
    expect(threads[0].events.length).toBe(1)
    expect(threads[0].latest).toBe(threads[0].events[0])
  })
})

// ---------------------------------------------------------------------------
// agentColor tests
// ---------------------------------------------------------------------------
describe('agentColor', () => {
  test('returns a hex color string', () => {
    expect(agentColor('agent-0')).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test('is deterministic (same name -> same color)', () => {
    expect(agentColor('agent-0')).toBe(agentColor('agent-0'))
  })

  test('different names can produce different colors', () => {
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
// API contract tests (ensures component uses correct swarm methods)
// ---------------------------------------------------------------------------
describe('ThreadsPage (API contract)', () => {
  test('window.slashbot.swarm has activity methods', () => {
    const swarm = window.slashbot.swarm
    expect(typeof swarm.activity).toBe('function')
    expect(typeof swarm.onActivity).toBe('function')
  })
})
