import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { mockSwarmStatus, mockTelegramStatus } = vi.hoisted(() => {
  const mockSwarmStatus = vi.fn().mockResolvedValue({ agents: [], stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 } })
  const mockTelegramStatus = vi.fn().mockResolvedValue({ connected: true, botUsername: 'testbot', lastError: null, messagesSent: 10, messagesReceived: 5 })
  const noop = vi.fn().mockReturnValue(() => {})
  const noopResolve = vi.fn().mockResolvedValue(undefined)

  // Set window.slashbot before any module-level access
  ;(globalThis as any).window = {
    slashbot: {
      swarm: {
        status: mockSwarmStatus,
        queue: vi.fn().mockResolvedValue([]),
        activity: vi.fn().mockResolvedValue([]),
        agentOutput: vi.fn().mockResolvedValue(''),
        agentLogs: vi.fn().mockResolvedValue([]),
        agentLogContent: vi.fn().mockResolvedValue(''),
        start: noopResolve,
        stop: noopResolve,
        gracefulStop: noopResolve,
        pauseAgent: noopResolve,
        resumeAgent: noopResolve,
        pauseAll: noopResolve,
        resumeAll: noopResolve,
        onLog: noop,
        onOutput: noop,
        onGraph: noop,
        onAgents: noop,
        onActivity: noop,
        onPlanPhase: noop,
        onPlanQueue: noop,
        onStopped: noop,
      },
      telegram: {
        status: mockTelegramStatus,
      },
    },
  }
  return { mockSwarmStatus, mockTelegramStatus }
})

// Mock App module to avoid transitive Dashboard import
vi.mock('../App', () => ({
  globalAgentOutputs: {},
}))

// Mock AgentOutputRenderer
vi.mock('../components/AgentOutputRenderer', () => ({
  default: ({ output }: { output: string }) => React.createElement('div', null, output),
}))

import SwarmPage, { TelegramStatusIndicator } from './SwarmPage'

beforeEach(() => {
  mockSwarmStatus.mockReset().mockResolvedValue({ agents: [], stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 } })
  mockTelegramStatus.mockReset().mockResolvedValue({ connected: true, botUsername: 'testbot', lastError: null, messagesSent: 10, messagesReceived: 5 })
})

describe('SwarmPage', () => {
  const defaultProps = {
    projectPath: '/tmp/test',
    agentOutputs: {},
    setAgentOutputs: vi.fn(),
    activity: [],
    setActivity: vi.fn(),
  }

  test('renders page header', () => {
    const html = renderToStaticMarkup(<SwarmPage {...defaultProps} />)
    expect(html).toContain('Agent Flywheel')
  })

  test('renders start swarm button when not running', () => {
    const html = renderToStaticMarkup(<SwarmPage {...defaultProps} />)
    expect(html).toContain('Start Swarm')
  })

  test('renders overview tab with empty state', () => {
    const html = renderToStaticMarkup(<SwarmPage {...defaultProps} />)
    expect(html).toContain('overview-grid')
    expect(html).toContain('No agents running')
  })
})

describe('TelegramStatusIndicator', () => {
  test('connected state renders green dot with tooltip', () => {
    const html = renderToStaticMarkup(
      <TelegramStatusIndicator status={{ connected: true, botUsername: 'mybot', messagesSent: 42, messagesReceived: 7, lastError: null }} />
    )
    expect(html).toContain('telegram-status connected')
    expect(html).toContain('telegram-dot green')
    expect(html).toContain('Telegram: @mybot')
    expect(html).toContain('Sent: 42')
    expect(html).toContain('Received: 7')
  })

  test('disconnected state renders red dot with error', () => {
    const html = renderToStaticMarkup(
      <TelegramStatusIndicator status={{ connected: false, botUsername: null, messagesSent: 0, messagesReceived: 0, lastError: 'Token invalid' }} />
    )
    expect(html).toContain('telegram-status disconnected')
    expect(html).toContain('telegram-dot red')
    expect(html).toContain('Telegram: disconnected')
    expect(html).toContain('Token invalid')
  })

  test('connected with null botUsername shows unknown', () => {
    const html = renderToStaticMarkup(
      <TelegramStatusIndicator status={{ connected: true, botUsername: null, messagesSent: 0, messagesReceived: 0, lastError: null }} />
    )
    expect(html).toContain('Telegram: @unknown')
  })

  test('disconnected without error omits error line', () => {
    const html = renderToStaticMarkup(
      <TelegramStatusIndicator status={{ connected: false, botUsername: null, messagesSent: 0, messagesReceived: 0, lastError: null }} />
    )
    expect(html).toContain('Telegram: disconnected')
    expect(html).not.toContain('\n')
  })
})
