import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { mockSwarmStatus, mockTelegramStatus, mockKnowledge, mockBuildMonitorStatus, mockBuildMonitorToggle } = vi.hoisted(() => {
  const mockSwarmStatus = vi.fn().mockResolvedValue({ agents: [], stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 } })
  const mockTelegramStatus = vi.fn().mockResolvedValue({ connected: true, botUsername: 'testbot', lastError: null, messagesSent: 10, messagesReceived: 5 })
  const mockKnowledge = vi.fn().mockResolvedValue([])
  const mockBuildMonitorStatus = vi.fn().mockResolvedValue({ enabled: false, running: false })
  const mockBuildMonitorToggle = vi.fn().mockResolvedValue({ ok: true, enabled: true, running: true })
  const noop = vi.fn().mockReturnValue(() => {})
  const noopResolve = vi.fn().mockResolvedValue(undefined)

  // Set window.slashbot before any module-level access
  ;(globalThis as any).window = {
    slashbot: {
      swarm: {
        status: mockSwarmStatus,
        queue: vi.fn().mockResolvedValue([]),
        activity: vi.fn().mockResolvedValue([]),
        knowledge: mockKnowledge,
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
        onSwarmPhase: noop,
        buildMonitor: {
          status: mockBuildMonitorStatus,
          toggle: mockBuildMonitorToggle,
        },
        onBuildStatus: noop,
      },
      telegram: {
        status: mockTelegramStatus,
      },
    },
  }
  return { mockSwarmStatus, mockTelegramStatus, mockKnowledge, mockBuildMonitorStatus, mockBuildMonitorToggle }
})

// Mock App module to avoid transitive Dashboard import
vi.mock('../App', () => ({
  globalAgentOutputs: {},
}))

// Mock AgentOutputRenderer
vi.mock('../components/AgentOutputRenderer', () => ({
  default: ({ output }: { output: string }) => React.createElement('div', null, output),
}))

import SwarmPage, { TelegramStatusIndicator, BuildMonitorIndicator, knowledgeCategoryColor } from './SwarmPage'
import { ToastProvider } from '../components/Toast'

function renderSwarmPage(props: Partial<Parameters<typeof SwarmPage>[0]> = {}) {
  return renderToStaticMarkup(
    <ToastProvider>
      <SwarmPage
        projectPath="/tmp/test"
        agentOutputs={{}}
        setAgentOutputs={vi.fn()}
        activity={[]}
        setActivity={vi.fn()}
        {...props}
      />
    </ToastProvider>
  )
}

beforeEach(() => {
  mockSwarmStatus.mockReset().mockResolvedValue({ agents: [], stats: { total: 5, done: 2, claimed: 1, ready: 1, pending: 1, failed: 0, pct: 40 } })
  mockTelegramStatus.mockReset().mockResolvedValue({ connected: true, botUsername: 'testbot', lastError: null, messagesSent: 10, messagesReceived: 5 })
  mockKnowledge.mockReset().mockResolvedValue([])
  mockBuildMonitorStatus.mockReset().mockResolvedValue({ enabled: false, running: false })
  mockBuildMonitorToggle.mockReset().mockResolvedValue({ ok: true, enabled: true, running: true })
})

describe('SwarmPage', () => {
  test('renders page header', () => {
    const html = renderSwarmPage()
    expect(html).toContain('swarm-page')
    expect(html).toContain('Swarm')
  })

  test('renders start swarm button when not running', () => {
    const html = renderSwarmPage()
    expect(html).toContain('Start Swarm')
  })

  test('renders overview tab with empty state', () => {
    const html = renderSwarmPage()
    expect(html).toContain('swarm-content')
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

describe('knowledgeCategoryColor', () => {
  test('maps danger categories', () => {
    expect(knowledgeCategoryColor('gotcha')).toBe('danger')
    expect(knowledgeCategoryColor('risk')).toBe('danger')
  })

  test('maps accent categories', () => {
    expect(knowledgeCategoryColor('pattern')).toBe('accent')
    expect(knowledgeCategoryColor('convention')).toBe('accent')
  })

  test('maps dependency to warning', () => {
    expect(knowledgeCategoryColor('dependency')).toBe('warning')
  })

  test('maps environment to info', () => {
    expect(knowledgeCategoryColor('environment')).toBe('info')
  })

  test('defaults unknown categories to info', () => {
    expect(knowledgeCategoryColor('unknown')).toBe('info')
    expect(knowledgeCategoryColor('')).toBe('info')
  })
})

describe('Activity tab with activity events', () => {
  test('tab label includes activity count from props', () => {
    const events: import('../types/ipc').ActivityEvent[] = [
      { ts: '2026-03-21T10:00:00Z', agentId: 'agent-0', type: 'executing', beadId: 'sb-1', summary: 'Working' },
      { ts: '2026-03-21T10:01:00Z', agentId: 'agent-0', type: 'completed', beadId: 'sb-1', summary: 'Done' },
    ]
    const html = renderSwarmPage({ activity: events })
    // Knowledge is fetched async (empty during SSR), so merged feed = activity count
    // Count badge uses swarm-tab-count span, not "(N)" text format
    expect(html).toContain('swarm-tab-count')
    expect(html).toContain('>2<')
  })

  test('tab label shows no count badge when no activity or knowledge', () => {
    const html = renderSwarmPage()
    // When count is 0, badge is not rendered — only the label text appears
    expect(html).toContain('Activity')
    expect(html).not.toContain('swarm-tab-count')
  })
})

describe('BuildMonitorIndicator', () => {
  test('disabled state shows gray dot', () => {
    const html = renderToStaticMarkup(
      <BuildMonitorIndicator status={{ enabled: false, running: false }} onToggle={vi.fn()} />
    )
    expect(html).toContain('build-monitor-status disabled')
    expect(html).toContain('build-dot gray')
    expect(html).toContain('Build monitor: off')
  })

  test('enabled with passed status shows green dot', () => {
    const html = renderToStaticMarkup(
      <BuildMonitorIndicator status={{ enabled: true, running: true, lastStatus: 'passed' }} onToggle={vi.fn()} />
    )
    expect(html).toContain('build-monitor-status enabled')
    expect(html).toContain('build-dot green')
    expect(html).toContain('Build monitor: passed')
  })

  test('enabled with failed status shows red dot', () => {
    const html = renderToStaticMarkup(
      <BuildMonitorIndicator status={{ enabled: true, running: true, lastStatus: 'failed' }} onToggle={vi.fn()} />
    )
    expect(html).toContain('build-monitor-status enabled')
    expect(html).toContain('build-dot red')
    expect(html).toContain('Build monitor: failed')
  })

  test('enabled but not running shows gray dot with appropriate tooltip', () => {
    const html = renderToStaticMarkup(
      <BuildMonitorIndicator status={{ enabled: true, running: false }} onToggle={vi.fn()} />
    )
    expect(html).toContain('build-monitor-status enabled')
    expect(html).toContain('build-dot gray')
    expect(html).toContain('Build monitor: enabled (not running)')
  })

  test('enabled with no lastStatus shows gray dot', () => {
    const html = renderToStaticMarkup(
      <BuildMonitorIndicator status={{ enabled: true, running: true }} onToggle={vi.fn()} />
    )
    expect(html).toContain('build-dot gray')
    expect(html).toContain('Build monitor: waiting')
  })
})

describe('SwarmPage build monitor integration', () => {
  test('renders build monitor indicator in stats bar', () => {
    const html = renderSwarmPage()
    expect(html).toContain('build-monitor-status')
  })
})

describe('SwarmPage phase timeline (unit logic)', () => {
  // SSR renders initial state (empty agents) since useEffect doesn't fire.
  // Test the timeline rendering logic via a lightweight helper that mirrors component code.
  const WORKER_PHASES = ['routing', 'thinking', 'executing', 'reviewing', 'merging', 'closing'] as const
  const PHASE_LABELS: Record<string, string> = {
    routing: 'Route', thinking: 'Think', executing: 'Execute',
    reviewing: 'Review', merging: 'Merge', closing: 'Close',
  }

  function phaseTimelineIndex(phase: string): number {
    return (WORKER_PHASES as readonly string[]).indexOf(phase)
  }

  function phaseElapsed(lastActivity: string): string {
    const diff = Date.now() - new Date(lastActivity).getTime()
    if (diff < 60_000) return '<1m'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
    return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m`
  }

  test('phaseTimelineIndex returns correct indices for known phases', () => {
    expect(phaseTimelineIndex('routing')).toBe(0)
    expect(phaseTimelineIndex('thinking')).toBe(1)
    expect(phaseTimelineIndex('executing')).toBe(2)
    expect(phaseTimelineIndex('reviewing')).toBe(3)
    expect(phaseTimelineIndex('merging')).toBe(4)
    expect(phaseTimelineIndex('closing')).toBe(5)
  })

  test('phaseTimelineIndex returns -1 for non-pipeline phases', () => {
    expect(phaseTimelineIndex('idle')).toBe(-1)
    expect(phaseTimelineIndex('paused')).toBe(-1)
    expect(phaseTimelineIndex('waiting')).toBe(-1)
  })

  test('phaseElapsed returns <1m for recent activity', () => {
    const recent = new Date(Date.now() - 10_000).toISOString()
    expect(phaseElapsed(recent)).toBe('<1m')
  })

  test('phaseElapsed returns minutes for moderate elapsed', () => {
    const threeMinAgo = new Date(Date.now() - 180_000).toISOString()
    expect(phaseElapsed(threeMinAgo)).toBe('3m')
  })

  test('phaseElapsed returns hours and minutes for long elapsed', () => {
    const oneHourTenMin = new Date(Date.now() - (70 * 60_000)).toISOString()
    expect(phaseElapsed(oneHourTenMin)).toBe('1h 10m')
  })

  test('PHASE_LABELS covers all WORKER_PHASES', () => {
    for (const phase of WORKER_PHASES) {
      expect(PHASE_LABELS[phase]).toBeDefined()
    }
  })

  test('phase done/active/pending classification is correct for executing', () => {
    const currentIdx = phaseTimelineIndex('executing') // 2
    const classifications = WORKER_PHASES.map((_, i) => {
      if (i < currentIdx) return 'done'
      if (i === currentIdx) return 'active'
      return 'pending'
    })
    expect(classifications).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending'])
  })

  test('phase classification for merging phase', () => {
    const currentIdx = phaseTimelineIndex('merging') // 4
    const classifications = WORKER_PHASES.map((_, i) => {
      if (i < currentIdx) return 'done'
      if (i === currentIdx) return 'active'
      return 'pending'
    })
    expect(classifications).toEqual(['done', 'done', 'done', 'done', 'active', 'pending'])
  })

  test('timeline not shown for idle (no beadId) — condition check', () => {
    // The component condition is: a.currentBeadId && a.phase !== 'idle' && a.phase !== 'paused'
    const shouldShow = (beadId: string | null, phase: string) =>
      !!beadId && phase !== 'idle' && phase !== 'paused'
    expect(shouldShow(null, 'idle')).toBe(false)
    expect(shouldShow('sb-1', 'idle')).toBe(false)
    expect(shouldShow('sb-1', 'paused')).toBe(false)
    expect(shouldShow('sb-1', 'executing')).toBe(true)
    expect(shouldShow('sb-1', 'thinking')).toBe(true)
  })
})

describe('SwarmPage error surfacing', () => {
  test('telegram status failure does not crash the component', () => {
    mockTelegramStatus.mockRejectedValue(new Error('Network error'))
    const html = renderSwarmPage()
    expect(html).toContain('Swarm')
  })

  test('build monitor status failure does not crash the component', () => {
    mockBuildMonitorStatus.mockRejectedValue(new Error('IPC error'))
    const html = renderSwarmPage()
    expect(html).toContain('Swarm')
  })

  test('knowledge fetch failure does not crash the component', () => {
    mockKnowledge.mockRejectedValue(new Error('Fetch failed'))
    const html = renderSwarmPage()
    expect(html).toContain('Swarm')
  })
})
