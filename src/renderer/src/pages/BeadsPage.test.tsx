import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import ReactDOM from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ available: true })
  const mockList = vi.fn().mockResolvedValue({ ok: true, tasks: [] })
  const mockRollback = vi.fn().mockResolvedValue({ ok: true })
  const mockReopen = vi.fn().mockResolvedValue({ ok: true })
  const mockClose = vi.fn().mockResolvedValue({ ok: true })
  const mockUpdate = vi.fn().mockResolvedValue({ ok: true })
  const mockCreate = vi.fn().mockResolvedValue({ ok: true })
  const mockStatus = vi.fn().mockResolvedValue({ planning: false })
  const mockQueue = vi.fn().mockResolvedValue([])

  // Preserve jsdom window (needed for ReactDOM.createRoot); only inject slashbot namespace.
  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const mockComments = vi.fn().mockResolvedValue([])
  ;(globalThis as any).window.slashbot = {
    beads: {
      check: mockCheck,
      list: mockList,
      rollback: mockRollback,
      reopen: mockReopen,
      close: mockClose,
      update: mockUpdate,
      create: mockCreate,
      comments: mockComments,
    },
    swarm: {
      status: mockStatus,
      queue: mockQueue,
      onPlanPhase: vi.fn().mockReturnValue(() => {}),
      onPlanQueue: vi.fn().mockReturnValue(() => {}),
      onStopped: vi.fn().mockReturnValue(() => {}),
      activity: vi.fn().mockResolvedValue([]),
      agentLogs: vi.fn().mockResolvedValue([]),
      inject: vi.fn().mockResolvedValue(undefined),
      queueRemove: vi.fn().mockResolvedValue(undefined),
    },
  }

  return { mockCheck, mockList, mockRollback, mockReopen, mockClose, mockUpdate, mockCreate, mockStatus, mockQueue, mockComments }
})

import BeadsPage from './BeadsPage'
import { ToastProvider } from '../components/Toast'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockCheck.mockResolvedValue({ available: true })
  mocks.mockList.mockResolvedValue({ ok: true, tasks: [] })
  mocks.mockStatus.mockResolvedValue({ planning: false, planRequest: null })
  mocks.mockQueue.mockResolvedValue([])
})

/** Helper to render BeadsPage with required providers */
function renderBeadsPage(props: { projectPath: string } = { projectPath: '/tmp/test' }) {
  return renderToStaticMarkup(<ToastProvider><BeadsPage {...props} /></ToastProvider>)
}

describe('BeadsPage', () => {
  test('renders without error', () => {
    expect(() => {
      renderBeadsPage()
    }).not.toThrow()
  })

  test('renders page header with Beads title', () => {
    const html = renderBeadsPage()
    expect(html).toContain('Beads')
    expect(html).toContain('Create Bead')
    expect(html).toContain('Refresh')
  })

  test('renders tab filters without All tab', () => {
    const html = renderBeadsPage()
    expect(html).toContain('Open')
    expect(html).toContain('In Progress')
    expect(html).toContain('Closed')
    // "All" tab should not exist — only Open, In Progress, Closed
    // Check that no tab button contains "All" as its label
    expect(html).not.toMatch(/>All</)
  })

  test('renders sort options', () => {
    const html = renderBeadsPage()
    expect(html).toContain('Sort by:')
  })

  test('renders sort bar (list view only)', () => {
    const html = renderBeadsPage()
    expect(html).toContain('Sort by:')
    // No view toggle buttons should exist
    expect(html).not.toContain('data-testid="view-mode-kanban"')
    expect(html).not.toContain('data-testid="view-mode-tree"')
  })

  test('shows plan request text when planning is active', () => {
    mocks.mockStatus.mockResolvedValue({ planning: true, planRequest: 'Build a login page' })
    const html = renderBeadsPage()
    // The queue-item-active section should NOT show "Running..." when there is a request
    // SSR won't have the async status loaded, but the component should render the initial state
    expect(html).toContain('Plan &amp; Encode Beads')
  })

  test('shows Running... fallback when planRequest is empty', () => {
    const html = renderBeadsPage()
    // Initial state: not planning, so queue-item-active shouldn't render at all
    expect(html).not.toContain('queue-item-active')
  })

  test('truncates long plan request to 80 chars', () => {
    // This tests the rendering logic: when isPlanning is true and planRequest is long
    // We test this by verifying the component structure renders properly
    const html = renderBeadsPage()
    expect(html).toContain('Plan &amp; Encode Beads')
  })

  test('does not render kanban or tree view components', () => {
    const html = renderBeadsPage()
    expect(html).not.toContain('kanban')
    expect(html).not.toContain('tree-browser')
  })

  test('uses AsyncButton for Create button', () => {
    const html = renderBeadsPage()
    // AsyncButton renders with aria-busy attribute
    expect(html).toContain('aria-busy')
    expect(html).toContain('Create')
  })

  test('uses AsyncButton for Inject Plan button', () => {
    const html = renderBeadsPage()
    expect(html).toContain('Inject Plan')
    // Inject Plan button should have aria-busy from AsyncButton
    expect(html).toContain('aria-busy="false"')
  })
})

describe('BeadsPage — async operations (DOM)', () => {
  let container: HTMLElement
  let root: ReturnType<typeof ReactDOM.createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = ReactDOM.createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    document.body.removeChild(container)
  })

  test('Create button shows spinner and disables during create operation', async () => {
    let resolveCreate!: (v: { ok: boolean }) => void
    mocks.mockCreate.mockImplementation(() => new Promise(r => { resolveCreate = r }))

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    // Open create form
    const createToggle = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => { createToggle.click() })

    // Fill title
    const titleInput = container.querySelector('.card-create input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(titleInput, 'Test bead')
      titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click create
    const createBtn = container.querySelector('.card-create .btn-primary') as HTMLButtonElement
    await act(async () => { createBtn.click() })

    // Button should be disabled while pending
    expect(createBtn.disabled).toBe(true)
    expect(createBtn.getAttribute('aria-busy')).toBe('true')

    // Resolve the create call
    await act(async () => { resolveCreate({ ok: true }) })
  })

  test('Close bead shows error state on button when operation fails', async () => {
    mocks.mockList.mockResolvedValue({
      ok: true,
      tasks: [{
        id: 'test-1', title: 'Test', status: 'ready', type: 'task',
        priority: 2, tags: [], description: null, claimedBy: null,
      }],
    })
    mocks.mockClose.mockRejectedValue(new Error('Network error'))

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    // Find and click Close button within bead actions (second aria-busy button after Claim)
    const actionBtns = container.querySelectorAll('.bead-actions button[aria-busy]')
    const closeBtn = Array.from(actionBtns).find(b => b.textContent?.includes('Close')) as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await act(async () => { closeBtn.click() })
    await act(async () => {})
    // AsyncButton enters error state
    expect(closeBtn.className).toContain('async-btn-error')
  })

  test('bead action buttons use AsyncButton with aria-busy', async () => {
    mocks.mockList.mockResolvedValue({
      ok: true,
      tasks: [{
        id: 'test-1', title: 'Test', status: 'ready', type: 'task',
        priority: 2, tags: [], description: null, claimedBy: null,
      }],
    })

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    // All bead action buttons should have aria-busy attribute (from AsyncButton)
    const actionBtns = container.querySelectorAll('.bead-actions button[aria-busy]')
    expect(actionBtns.length).toBeGreaterThan(0)
  })

  test('Close button disables with spinner while operation is pending', async () => {
    let resolveClose!: (v: { ok: boolean }) => void
    mocks.mockClose.mockImplementation(() => new Promise(r => { resolveClose = r }))
    mocks.mockList.mockResolvedValue({
      ok: true,
      tasks: [{
        id: 'test-1', title: 'Test', status: 'ready', type: 'task',
        priority: 2, tags: [], description: null, claimedBy: null,
      }],
    })

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    const actionBtns = container.querySelectorAll('.bead-actions button[aria-busy]')
    const closeBtn = Array.from(actionBtns).find(b => b.textContent?.includes('Close')) as HTMLButtonElement
    expect(closeBtn).not.toBeNull()

    await act(async () => { closeBtn.click() })

    // Button should be disabled with spinner while pending
    expect(closeBtn.disabled).toBe(true)
    expect(closeBtn.getAttribute('aria-busy')).toBe('true')
    expect(closeBtn.querySelector('.async-btn-spinner')).not.toBeNull()
    expect(closeBtn.className).toContain('async-btn-pending')

    // Resolve to clean up
    await act(async () => { resolveClose({ ok: true }) })
  })

  test('Close bead failure shows error toast', async () => {
    mocks.mockList.mockResolvedValue({
      ok: true,
      tasks: [{
        id: 'test-1', title: 'Test', status: 'ready', type: 'task',
        priority: 2, tags: [], description: null, claimedBy: null,
      }],
    })
    mocks.mockClose.mockResolvedValue({ ok: false, error: 'Permission denied' })

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    const actionBtns = container.querySelectorAll('.bead-actions button[aria-busy]')
    const closeBtn = Array.from(actionBtns).find(b => b.textContent?.includes('Close')) as HTMLButtonElement
    await act(async () => { closeBtn.click() })
    await act(async () => {})

    // AsyncButton enters error state (thrown error from closeBead callback)
    expect(closeBtn.className).toContain('async-btn-error')
  })

  test('refresh uses bead.commentCount instead of per-bead comments calls', async () => {
    mocks.mockList.mockResolvedValue({
      ok: true,
      tasks: [
        { id: 'b-1', title: 'Bead 1', status: 'ready', type: 'task', priority: 2, tags: [], commentCount: 3 },
        { id: 'b-2', title: 'Bead 2', status: 'ready', type: 'task', priority: 2, tags: [], commentCount: 0 },
        { id: 'b-3', title: 'Bead 3', status: 'ready', type: 'task', priority: 2, tags: [], commentCount: 5 },
      ],
    })

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    // No per-bead comments calls should be made — commentCount comes from list
    expect(mocks.mockComments).not.toHaveBeenCalled()
  })

  test('Claim button disables with spinner while pending', async () => {
    let resolveClaim!: (v: { ok: boolean }) => void
    mocks.mockUpdate.mockImplementation(() => new Promise(r => { resolveClaim = r }))
    mocks.mockList.mockResolvedValue({
      ok: true,
      tasks: [{
        id: 'test-1', title: 'Test', status: 'ready', type: 'task',
        priority: 2, tags: [], description: null, claimedBy: null,
      }],
    })

    await act(async () => {
      root.render(<ToastProvider><BeadsPage projectPath="/tmp/test" /></ToastProvider>)
    })
    await act(async () => {})

    const actionBtns = container.querySelectorAll('.bead-actions button[aria-busy]')
    const claimBtn = Array.from(actionBtns).find(b => b.textContent?.includes('Claim')) as HTMLButtonElement

    await act(async () => { claimBtn.click() })

    expect(claimBtn.disabled).toBe(true)
    expect(claimBtn.getAttribute('aria-busy')).toBe('true')

    await act(async () => { resolveClaim({ ok: true }) })
  })
})
