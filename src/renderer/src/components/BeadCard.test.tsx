import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Bead, FileLock } from '../types/ipc'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mockComments = vi.fn().mockResolvedValue([])
const mockAddComment = vi.fn().mockResolvedValue({ ok: true })
const mockActivity = vi.fn().mockResolvedValue([])
const mockAgentLogs = vi.fn().mockResolvedValue([])

;(window as any).slashbot = {
  ...(window as any).slashbot,
  beads: {
    ...((window as any).slashbot?.beads ?? {}),
    comments: mockComments,
    addComment: mockAddComment,
  },
  swarm: {
    ...((window as any).slashbot?.swarm ?? {}),
    activity: mockActivity,
    agentLogs: mockAgentLogs,
    agentLogContent: vi.fn().mockResolvedValue(''),
  },
}

import BeadCard, { type BeadCardProps } from './BeadCard'

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'test-1', title: 'Test Bead', description: 'A test bead', type: 'task',
    status: 'ready', deps: [], files: [], priority: 2, tags: [],
    ...overrides,
  }
}

function makeProps(overrides: Partial<BeadCardProps> = {}): BeadCardProps {
  return {
    bead: makeBead(),
    projectPath: '/tmp/test',
    expanded: false,
    onToggleExpand: vi.fn(),
    commentCount: 0,
    locks: [],
    onClaim: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn().mockResolvedValue(undefined),
    onReopen: vi.fn().mockResolvedValue(undefined),
    onRollback: vi.fn().mockResolvedValue(undefined),
    onForceUnlock: vi.fn().mockResolvedValue(undefined),
    onChangePriority: vi.fn(),
    onStartEdit: vi.fn(),
    index: 0,
    isDragging: false,
    isDropTarget: false,
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDragEnd: vi.fn(),
    ...overrides,
  }
}

let container: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  mockComments.mockResolvedValue([])
  mockActivity.mockResolvedValue([])
  mockAgentLogs.mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  document.body.removeChild(container)
})

describe('BeadCard', () => {
  test('renders bead id, title, and status badge', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps()} />)
    expect(html).toContain('test-1')
    expect(html).toContain('Test Bead')
    expect(html).toContain('open') // statusLabel for 'ready'
  })

  test('renders chevron indicator in collapsed state', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps()} />)
    expect(html).toContain('bead-expand-chevron')
    expect(html).not.toContain('bead-expand-chevron-open')
  })

  test('renders chevron in open state when expanded', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ expanded: true })} />)
    expect(html).toContain('bead-expand-chevron-open')
    expect(html).toContain('bead-card-expanded')
  })

  test('shows comment count badge when commentCount > 0', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ commentCount: 5 })} />)
    expect(html).toContain('bead-comment-badge')
    expect(html).toContain('5')
  })

  test('hides comment badge when commentCount is 0', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ commentCount: 0 })} />)
    expect(html).not.toContain('bead-comment-badge')
  })

  test('renders BeadDetailPanel and CommentThread when expanded', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ expanded: true })} />)
    expect(html).toContain('bead-detail-panel')
    expect(html).toContain('comment-thread')
    expect(html).toContain('bead-card-detail-section')
  })

  test('does not render detail section when collapsed', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ expanded: false })} />)
    expect(html).not.toContain('bead-card-detail-section')
    expect(html).not.toContain('comment-thread')
  })

  test('shows Expand button when collapsed, Collapse when expanded', () => {
    const collapsed = renderToStaticMarkup(<BeadCard {...makeProps({ expanded: false })} />)
    expect(collapsed).toContain('Expand')
    expect(collapsed).not.toContain('Collapse')

    const expanded = renderToStaticMarkup(<BeadCard {...makeProps({ expanded: true })} />)
    expect(expanded).toContain('Collapse')
  })

  test('renders action buttons for ready status', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ bead: makeBead({ status: 'ready' }) })} />)
    expect(html).toContain('Claim')
    expect(html).toContain('Close')
  })

  test('renders action buttons for claimed status', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ bead: makeBead({ status: 'claimed' }) })} />)
    expect(html).toContain('Back to Open')
    expect(html).toContain('Close')
  })

  test('renders action buttons for done status', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ bead: makeBead({ status: 'done' }) })} />)
    expect(html).toContain('Reopen')
    expect(html).toContain('Rollback')
  })

  test('renders tags when present', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ bead: makeBead({ tags: ['frontend', 'ui'] }) })} />)
    expect(html).toContain('frontend')
    expect(html).toContain('ui')
  })

  test('shows lock badge when locked', () => {
    const locks: FileLock[] = [{ file: 'src/a.ts', agentId: 'worker-0', beadId: 'test-1', reservedAt: new Date().toISOString() }]
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ locks })} />)
    expect(html).toContain('locked')
    expect(html).not.toContain('stale lock')
  })

  test('shows stale lock badge when lock is old', () => {
    const oldDate = new Date(Date.now() - 45 * 60_000).toISOString()
    const locks: FileLock[] = [{ file: 'src/a.ts', agentId: 'worker-0', beadId: 'test-1', reservedAt: oldDate }]
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ locks })} />)
    expect(html).toContain('stale lock')
    expect(html).toContain('Force Unlock')
  })

  test('disables Edit button when locked', () => {
    const locks: FileLock[] = [{ file: 'src/a.ts', agentId: 'worker-0', beadId: 'test-1', reservedAt: new Date().toISOString() }]
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ locks })} />)
    expect(html).toContain('Cannot edit while locked')
  })

  test('shows claimedBy agent tag', () => {
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ bead: makeBead({ claimedBy: 'agent-x' }) })} />)
    expect(html).toContain('agent-x')
    expect(html).toContain('tag-agent')
  })

  test('applies dragging/drop-target classes', () => {
    const dragging = renderToStaticMarkup(<BeadCard {...makeProps({ isDragging: true })} />)
    expect(dragging).toContain('bead-dragging')

    const dropTarget = renderToStaticMarkup(<BeadCard {...makeProps({ isDropTarget: true })} />)
    expect(dropTarget).toContain('bead-drop-target')
  })

  test('truncates long description to 200 chars', () => {
    const longDesc = 'x'.repeat(300)
    const html = renderToStaticMarkup(<BeadCard {...makeProps({ bead: makeBead({ description: longDesc }) })} />)
    expect(html).not.toContain('x'.repeat(300))
    expect(html).toContain('x'.repeat(200))
  })
})

describe('BeadCard — interactions (DOM)', () => {
  test('clicking header calls onToggleExpand', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onToggleExpand: onToggle })} />)
    })

    const header = container.querySelector('.bead-card-header') as HTMLElement
    await act(async () => { header.click() })

    expect(onToggle).toHaveBeenCalledWith('test-1')
  })

  test('clicking title also toggles expand', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onToggleExpand: onToggle })} />)
    })

    const title = container.querySelector('.bead-title') as HTMLElement
    await act(async () => { title.click() })

    expect(onToggle).toHaveBeenCalledWith('test-1')
  })

  test('clicking priority select does not toggle expand', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onToggleExpand: onToggle })} />)
    })

    const select = container.querySelector('.priority-select') as HTMLSelectElement
    await act(async () => { select.click() })

    expect(onToggle).not.toHaveBeenCalled()
  })

  test('pressing Enter on header toggles expand (keyboard accessibility)', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onToggleExpand: onToggle })} />)
    })

    const header = container.querySelector('.bead-card-header') as HTMLElement
    await act(async () => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onToggle).toHaveBeenCalledWith('test-1')
  })

  test('pressing Space on header toggles expand (keyboard accessibility)', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onToggleExpand: onToggle })} />)
    })

    const header = container.querySelector('.bead-card-header') as HTMLElement
    await act(async () => {
      header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })

    expect(onToggle).toHaveBeenCalledWith('test-1')
  })

  test('clicking comment badge expands and calls toggle when collapsed', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ commentCount: 3, onToggleExpand: onToggle })} />)
    })

    const badge = container.querySelector('.bead-comment-badge') as HTMLButtonElement
    await act(async () => { badge.click() })

    expect(onToggle).toHaveBeenCalledWith('test-1')
  })

  test('Expand button calls onToggleExpand', async () => {
    const onToggle = vi.fn()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onToggleExpand: onToggle })} />)
    })

    const btns = container.querySelectorAll('.bead-actions .btn')
    const expandBtn = Array.from(btns).find(b => b.textContent === 'Expand') as HTMLButtonElement
    expect(expandBtn).not.toBeNull()

    await act(async () => { expandBtn.click() })
    expect(onToggle).toHaveBeenCalledWith('test-1')
  })

  test('Claim button calls onClaim', async () => {
    const onClaim = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onClaim })} />)
    })

    const claimBtn = Array.from(container.querySelectorAll('.bead-actions button[aria-busy]'))
      .find(b => b.textContent?.includes('Claim')) as HTMLButtonElement
    expect(claimBtn).not.toBeNull()

    await act(async () => { claimBtn.click() })
    expect(onClaim).toHaveBeenCalledWith('test-1')
  })

  test('Close button calls onClose', async () => {
    const onClose = vi.fn().mockResolvedValue(undefined)
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ onClose })} />)
    })

    const closeBtn = Array.from(container.querySelectorAll('.bead-actions button[aria-busy]'))
      .find(b => b.textContent?.includes('Close')) as HTMLButtonElement
    expect(closeBtn).not.toBeNull()

    await act(async () => { closeBtn.click() })
    expect(onClose).toHaveBeenCalledWith('test-1')
  })

  test('Edit button calls onStartEdit', async () => {
    const onStartEdit = vi.fn()
    const bead = makeBead()
    await act(async () => {
      createRoot(container).render(<BeadCard {...makeProps({ bead, onStartEdit })} />)
    })

    const editBtn = Array.from(container.querySelectorAll('.bead-actions .btn'))
      .find(b => b.textContent === 'Edit') as HTMLButtonElement
    expect(editBtn).not.toBeNull()

    await act(async () => { editBtn.click() })
    expect(onStartEdit).toHaveBeenCalledWith(bead)
  })
})
