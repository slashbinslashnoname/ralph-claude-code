import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Bead } from '../types/ipc'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mockActivity = vi.fn().mockResolvedValue([])
const mockComments = vi.fn().mockResolvedValue([])
const mockAddComment = vi.fn().mockResolvedValue({ ok: true })

;(window as any).slashbot = {
  ...(window as any).slashbot,
  swarm: {
    ...((window as any).slashbot?.swarm ?? {}),
    activity: mockActivity,
  },
  beads: {
    ...((window as any).slashbot?.beads ?? {}),
    comments: mockComments,
    addComment: mockAddComment,
  },
}

import UnifiedTimeline from './UnifiedTimeline'

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'sb-test.1',
    title: 'Test Bead',
    description: 'A test bead',
    type: 'task',
    status: 'ready',
    deps: [],
    files: [],
    priority: 2,
    tags: [],
    ...overrides,
  }
}

let domContainer: HTMLDivElement | null = null

beforeEach(() => {
  mockActivity.mockClear().mockResolvedValue([])
  mockComments.mockClear().mockResolvedValue([])
  mockAddComment.mockClear().mockResolvedValue({ ok: true })
  domContainer = document.createElement('div')
  document.body.appendChild(domContainer)
})

afterEach(() => {
  if (domContainer) {
    document.body.removeChild(domContainer)
    domContainer = null
  }
})

describe('UnifiedTimeline', () => {
  test('renders loading state initially via SSR', () => {
    const html = renderToStaticMarkup(
      <UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />
    )
    expect(html).toContain('Loading timeline')
    expect(html).toContain('unified-timeline')
  })

  test('renders empty state when no data exists', async () => {
    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('No activity yet')
    expect(html).toContain('Timeline (0)')
  })

  test('renders activity events in timeline', async () => {
    mockActivity.mockResolvedValue([
      {
        ts: '2026-04-10T12:00:00Z',
        agentId: 'worker-0',
        type: 'claimed',
        beadId: 'sb-test.1',
        summary: 'Claimed bead sb-test.1',
      },
      {
        ts: '2026-04-10T12:05:00Z',
        agentId: 'worker-0',
        type: 'thinking',
        beadId: 'sb-test.1',
        summary: 'Analyzing codebase',
      },
    ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('worker-0')
    expect(html).toContain('claimed')
    expect(html).toContain('thinking')
    expect(html).toContain('Claimed bead sb-test.1')
    expect(html).toContain('Analyzing codebase')
  })

  test('renders comments in timeline', async () => {
    mockComments.mockResolvedValue([
      {
        id: 'c1',
        issueId: 'sb-test.1',
        author: 'alice',
        text: 'Nice work!',
        createdAt: '2026-04-10T13:00:00Z',
      },
    ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('alice')
    expect(html).toContain('Nice work!')
    expect(html).toContain('comment')
  })

  test('renders lifecycle events from bead metadata', async () => {
    const bead = makeBead({
      createdAt: '2026-04-10T10:00:00Z',
    })

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={bead} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('created')
    expect(html).toContain('Bead created: Test Bead')
    expect(html).toContain('Timeline (1)')
  })

  test('merges and sorts all entry types chronologically', async () => {
    const bead = makeBead({
      createdAt: '2026-04-10T10:00:00Z',
    })

    mockActivity.mockResolvedValue([
      {
        ts: '2026-04-10T12:00:00Z',
        agentId: 'worker-0',
        type: 'executing',
        beadId: 'sb-test.1',
        summary: 'Running implementation',
      },
    ])

    mockComments.mockResolvedValue([
      {
        id: 'c1',
        issueId: 'sb-test.1',
        author: 'bob',
        text: 'LGTM',
        createdAt: '2026-04-10T11:00:00Z',
      },
    ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={bead} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('Timeline (3)')

    // Check ordering: created (10:00) -> comment (11:00) -> executing (12:00)
    const createdIdx = html.indexOf('Bead created')
    const commentIdx = html.indexOf('LGTM')
    const execIdx = html.indexOf('Running implementation')
    expect(createdIdx).toBeLessThan(commentIdx)
    expect(commentIdx).toBeLessThan(execIdx)
  })

  test('deduplicates lifecycle events that match activity events', async () => {
    const bead = makeBead({
      createdAt: '2026-04-10T10:00:00Z',
      claimedAt: '2026-04-10T12:00:00Z',
      claimedBy: 'worker-0',
    })

    // Activity also has a 'claimed' event — should deduplicate
    mockActivity.mockResolvedValue([
      {
        ts: '2026-04-10T12:00:00Z',
        agentId: 'worker-0',
        type: 'claimed',
        beadId: 'sb-test.1',
        summary: 'Claimed bead',
      },
    ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={bead} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    // created (lifecycle) + claimed (activity, lifecycle deduplicated) = 2
    expect(html).toContain('Timeline (2)')
  })

  test('filters activity events to only the target bead', async () => {
    mockActivity.mockResolvedValue([
      {
        ts: '2026-04-10T12:00:00Z',
        agentId: 'worker-0',
        type: 'claimed',
        beadId: 'sb-test.1',
        summary: 'This bead',
      },
      {
        ts: '2026-04-10T12:01:00Z',
        agentId: 'worker-1',
        type: 'claimed',
        beadId: 'sb-other.2',
        summary: 'Other bead',
      },
    ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('This bead')
    expect(html).not.toContain('Other bead')
  })

  test('renders file changes and branch tags', async () => {
    mockActivity.mockResolvedValue([
      {
        ts: '2026-04-10T12:00:00Z',
        agentId: 'worker-0',
        type: 'merged',
        beadId: 'sb-test.1',
        summary: 'Merged changes',
        filesChanged: ['src/app.ts', 'src/utils.ts'],
        branch: 'feat/timeline',
      },
    ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('src/app.ts')
    expect(html).toContain('src/utils.ts')
    expect(html).toContain('feat/timeline')
  })

  test('renders comment input area with textarea and button', async () => {
    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const textarea = domContainer!.querySelector('.comment-textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.placeholder).toBe('Add a comment...')

    const btn = domContainer!.querySelector('.unified-timeline-comment-input .btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Comment')
    expect(btn.disabled).toBe(true)
  })

  test('posting a comment calls addComment and refreshes', async () => {
    mockComments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'c1', issueId: 'sb-test.1', author: 'me', text: 'Hello world', createdAt: '2026-04-10T14:00:00Z' },
      ])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(domContainer!.innerHTML).toContain('No activity yet')

    // Type into textarea
    const textarea = domContainer!.querySelector('.comment-textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Hello world')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Click Comment button
    const btn = domContainer!.querySelector('.unified-timeline-comment-input .btn') as HTMLButtonElement
    await act(async () => { btn.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(mockAddComment).toHaveBeenCalledWith('/tmp/test', 'sb-test.1', 'Hello world')
    expect(domContainer!.innerHTML).toContain('Hello world')
    expect(domContainer!.innerHTML).toContain('Timeline (1)')
  })

  test('handles API errors gracefully', async () => {
    mockActivity.mockRejectedValue(new Error('Network error'))
    mockComments.mockRejectedValue(new Error('Network error'))

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('No activity yet')
  })

  test('calls APIs with correct arguments', async () => {
    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead({ id: 'sb-xyz.5' })} projectPath="/my/project" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(mockActivity).toHaveBeenCalledWith('/my/project', 500)
    expect(mockComments).toHaveBeenCalledWith('/my/project', 'sb-xyz.5')
  })

  test('shows "Show more" button when entries exceed page size', async () => {
    // Create 60 activity events (exceeds PAGE_SIZE of 50)
    const manyEvents = Array.from({ length: 60 }, (_, i) => ({
      ts: new Date(2026, 3, 10, 12, i).toISOString(),
      agentId: 'worker-0',
      type: 'executing' as const,
      beadId: 'sb-test.1',
      summary: `Event ${i}`,
    }))

    mockActivity.mockResolvedValue(manyEvents)

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(<UnifiedTimeline bead={makeBead()} projectPath="/tmp/test" />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    const html = domContainer!.innerHTML
    expect(html).toContain('Show more')
    expect(html).toContain('10 remaining')
  })
})
