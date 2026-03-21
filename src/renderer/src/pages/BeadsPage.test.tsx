import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
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

  ;(globalThis as any).window = {
    slashbot: {
      beads: {
        check: mockCheck,
        list: mockList,
        rollback: mockRollback,
        reopen: mockReopen,
        close: mockClose,
        update: mockUpdate,
        create: mockCreate,
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
    },
  }

  return { mockCheck, mockList, mockRollback, mockReopen, mockClose, mockUpdate, mockCreate, mockStatus, mockQueue }
})

import BeadsPage from './BeadsPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockCheck.mockResolvedValue({ available: true })
  mocks.mockList.mockResolvedValue({ ok: true, tasks: [] })
  mocks.mockStatus.mockResolvedValue({ planning: false })
  mocks.mockQueue.mockResolvedValue([])
})

describe('BeadsPage', () => {
  test('renders without error', () => {
    expect(() => {
      renderToStaticMarkup(<BeadsPage projectPath="/tmp/test" />)
    }).not.toThrow()
  })

  test('renders page header with Beads title', () => {
    const html = renderToStaticMarkup(<BeadsPage projectPath="/tmp/test" />)
    expect(html).toContain('Beads')
    expect(html).toContain('Create Bead')
    expect(html).toContain('Refresh')
  })

  test('renders tab filters', () => {
    const html = renderToStaticMarkup(<BeadsPage projectPath="/tmp/test" />)
    expect(html).toContain('All')
    expect(html).toContain('Open')
    expect(html).toContain('In Progress')
    expect(html).toContain('Closed')
  })

  test('renders sort options', () => {
    const html = renderToStaticMarkup(<BeadsPage projectPath="/tmp/test" />)
    expect(html).toContain('Sort by:')
  })
})
