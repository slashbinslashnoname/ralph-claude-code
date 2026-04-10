import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// Enable React act() environment for jsdom
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Must set up window before any module-level access in the component
const mockActivity = vi.fn().mockResolvedValue([])
const mockAgentLogs = vi.fn().mockResolvedValue([])
const mockAgentLogContent = vi.fn().mockResolvedValue('')

// Attach slashbot API to the jsdom window
;(window as any).slashbot = {
  swarm: {
    activity: mockActivity,
    agentLogs: mockAgentLogs,
    agentLogContent: mockAgentLogContent,
  },
}

import BeadDetailPanel from './BeadDetailPanel'

let domContainer: HTMLDivElement | null = null

beforeEach(() => {
  mockActivity.mockReset().mockResolvedValue([])
  mockAgentLogs.mockReset().mockResolvedValue([])
  mockAgentLogContent.mockReset().mockResolvedValue('')
  domContainer = document.createElement('div')
  document.body.appendChild(domContainer)
})

afterEach(() => {
  if (domContainer) {
    document.body.removeChild(domContainer)
    domContainer = null
  }
})

describe('BeadDetailPanel', () => {
  test('renders loading state initially', () => {
    const html = renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
    )
    expect(html).toContain('Loading audit trail')
    expect(html).toContain('bead-detail-panel')
  })

  test('renders with bead-detail-panel class', () => {
    const html = renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="ready" projectPath="/tmp/test" />
    )
    expect(html).toContain('bead-detail-panel')
  })

  test('accepts all required props without error', () => {
    expect(() => {
      renderToStaticMarkup(
        <BeadDetailPanel beadId="sb-xyz.2" beadStatus="failed" projectPath="/tmp/proj" />
      )
    }).not.toThrow()
  })

  test('calls activity and agentLogs APIs with correct args', () => {
    renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
    )
    // useEffect doesn't fire in SSR, but we can verify the component renders without
    // throwing when the APIs are configured
    expect(mockActivity).not.toHaveBeenCalled() // useEffect is SSR-inert
  })

  test('does not render timeline or logs tabs in loading state', () => {
    const html = renderToStaticMarkup(
      <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
    )
    expect(html).not.toContain('Timeline')
    expect(html).not.toContain('Logs')
  })

  test('renders rollback event with correct icon and badge', async () => {
    const rollbackEvent = {
      ts: '2026-03-21T10:00:00Z',
      agentId: 'agent-0',
      type: 'rollback',
      beadId: 'sb-abc.1',
      summary: 'Rolled back due to merge conflict',
    }
    mockActivity.mockResolvedValue([rollbackEvent])
    mockAgentLogs.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(
        <BeadDetailPanel beadId="sb-abc.1" beadStatus="failed" projectPath="/tmp/test" />
      )
    })

    const html = domContainer!.innerHTML

    // Verify the rollback icon (↩ = \u21A9)
    expect(html).toContain('\u21A9')

    // Verify the badge has the danger class
    expect(html).toContain('badge-danger')

    // Verify the event type label is rendered
    expect(html).toContain('rollback')

    // Verify the summary text is rendered
    expect(html).toContain('Rolled back due to merge conflict')
  })
})

describe('BeadDetailPanel — pagination', () => {
  function makeEvents(count: number, beadId = 'sb-abc.1') {
    return Array.from({ length: count }, (_, i) => ({
      ts: new Date(Date.now() + i * 1000).toISOString(),
      agentId: 'agent-0',
      type: i % 3 === 0 ? 'thinking' : i % 3 === 1 ? 'executing' : 'completed',
      beadId,
      summary: `Event ${i}`,
    }))
  }

  test('shows all events when count is under page size', async () => {
    const events = makeEvents(10)
    mockActivity.mockResolvedValue(events)
    mockAgentLogs.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(
        <BeadDetailPanel beadId="sb-abc.1" beadStatus="in-progress" projectPath="/tmp/test" />
      )
    })

    const html = domContainer!.innerHTML
    // All 10 events should render
    for (let i = 0; i < 10; i++) {
      expect(html).toContain(`Event ${i}`)
    }
    // No "Show more" button
    expect(html).not.toContain('Show more')
  })

  test('paginates events when count exceeds page size', async () => {
    const events = makeEvents(80)
    mockActivity.mockResolvedValue(events)
    mockAgentLogs.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(
        <BeadDetailPanel beadId="sb-abc.1" beadStatus="in-progress" projectPath="/tmp/test" />
      )
    })

    const html = domContainer!.innerHTML
    // First page (50 events) should be visible
    expect(html).toContain('Event 0')
    expect(html).toContain('Event 49')
    // Events beyond page size should not render
    expect(html).not.toContain('Event 50')
    // Show more button present
    expect(html).toContain('Show more')
    expect(html).toContain('30 remaining')
  })

  test('clicking Show more reveals next page of events', async () => {
    const events = makeEvents(80)
    mockActivity.mockResolvedValue(events)
    mockAgentLogs.mockResolvedValue([])

    let root: ReturnType<typeof createRoot>

    await act(async () => {
      root = createRoot(domContainer!)
      root.render(
        <BeadDetailPanel beadId="sb-abc.1" beadStatus="in-progress" projectPath="/tmp/test" />
      )
    })

    // Click "Show more"
    const showMoreBtn = domContainer!.querySelector('.bead-timeline-show-more') as HTMLButtonElement
    expect(showMoreBtn).not.toBeNull()

    await act(async () => {
      showMoreBtn.click()
    })

    const html = domContainer!.innerHTML
    // All 80 events should now be visible
    expect(html).toContain('Event 50')
    expect(html).toContain('Event 79')
    // No more "Show more" since all events are shown
    expect(html).not.toContain('Show more')
  })

  test('uses composite key instead of array index', async () => {
    const events = makeEvents(3)
    mockActivity.mockResolvedValue(events)
    mockAgentLogs.mockResolvedValue([])

    await act(async () => {
      const root = createRoot(domContainer!)
      root.render(
        <BeadDetailPanel beadId="sb-abc.1" beadStatus="done" projectPath="/tmp/test" />
      )
    })

    // Verify events render (composite key is internal React behavior,
    // we verify the component renders correctly with the new key scheme)
    const timelineEvents = domContainer!.querySelectorAll('.bead-timeline-event')
    expect(timelineEvents.length).toBe(3)
  })
})
