import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ActivityEvent, TelegramNotifyLevel } from '../types'

// Minimal mock TelegramBot
function createMockBot() {
  const handlers = new Map<string, Function>()
  return {
    sendMessage: vi.fn().mockResolvedValue(true),
    onCommand: vi.fn((cmd: string, handler: Function) => handlers.set(cmd, handler)),
    getStatus: vi.fn().mockReturnValue({
      connected: true,
      botUsername: 'testbot',
      lastError: null,
      messagesSent: 5,
      messagesReceived: 2,
    }),
    isConnected: vi.fn().mockReturnValue(true),
    _handlers: handlers,
  }
}

// Minimal mock orchestrator
function createMockOrchestrator() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    injectPlan: vi.fn().mockReturnValue({ id: 'plan-123' }),
    pauseAllWorkers: vi.fn(),
    resumeAllWorkers: vi.fn(),
    gracefulStopWorkers: vi.fn(),
    coordinator: {
      bdClient: {
        create: vi.fn().mockReturnValue({ id: 'sb-abc' }),
      },
    },
  })
}

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    ts: new Date().toISOString(),
    agentId: 'agent-0',
    type: 'completed',
    beadId: 'sb-001',
    beadTitle: 'Test bead',
    summary: 'Did something',
    ...overrides,
  }
}

// Import after mocks are set up
import { TelegramBridge } from './TelegramBridge'

describe('TelegramBridge', () => {
  let bot: ReturnType<typeof createMockBot>
  let orchestrator: ReturnType<typeof createMockOrchestrator>
  let bridge: TelegramBridge

  beforeEach(() => {
    vi.useFakeTimers()
    bot = createMockBot()
    orchestrator = createMockOrchestrator()
  })

  afterEach(() => {
    bridge?.stop()
    vi.useRealTimers()
  })

  function createBridge(notifyOn: TelegramNotifyLevel = 'all') {
    bridge = new TelegramBridge({
      orchestrator: orchestrator as any,
      bot: bot as any,
      notifyOn,
      logger: () => {},
    })
    bridge.start()
    return bridge
  }

  // ── Filtering ───────────────────────────────────────────────────────────

  describe('notifyOn filtering', () => {
    it('all: forwards every event type', () => {
      createBridge('all')
      orchestrator.emit('activity', makeEvent({ type: 'thinking' }))
      orchestrator.emit('activity', makeEvent({ type: 'completed' }))
      orchestrator.emit('activity', makeEvent({ type: 'failed' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      expect(msg).toContain('thinking')
      expect(msg).toContain('completed')
      expect(msg).toContain('failed')
    })

    it('errors: only forwards failed and rollback', () => {
      createBridge('errors')
      orchestrator.emit('activity', makeEvent({ type: 'started' }))
      orchestrator.emit('activity', makeEvent({ type: 'completed' }))
      orchestrator.emit('activity', makeEvent({ type: 'failed' }))
      orchestrator.emit('activity', makeEvent({ type: 'rollback' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      expect(msg).toContain('failed')
      expect(msg).toContain('rollback')
      expect(msg).not.toContain('started')
      expect(msg).not.toContain('✅') // completed emoji
    })

    it('completions: forwards milestone events', () => {
      createBridge('completions')
      orchestrator.emit('activity', makeEvent({ type: 'thinking' }))
      orchestrator.emit('activity', makeEvent({ type: 'completed' }))
      orchestrator.emit('activity', makeEvent({ type: 'merged' }))
      orchestrator.emit('activity', makeEvent({ type: 'failed' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      expect(msg).toContain('completed')
      expect(msg).toContain('merged')
      expect(msg).toContain('failed')
      expect(msg).not.toContain('thinking')
    })

    it('none: forwards nothing', () => {
      createBridge('none')
      orchestrator.emit('activity', makeEvent({ type: 'completed' }))
      orchestrator.emit('activity', makeEvent({ type: 'failed' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).not.toHaveBeenCalled()
    })
  })

  // ── Emoji formatting ───────────────────────────────────────────────────

  describe('emoji formatting', () => {
    it('uses correct emoji for each event type', () => {
      createBridge('all')
      orchestrator.emit('activity', makeEvent({ type: 'completed', agentId: 'agent-1' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage.mock.calls[0][0]).toContain('✅')
    })

    it('includes agent, bead, and summary in formatted message', () => {
      createBridge('all')
      orchestrator.emit(
        'activity',
        makeEvent({
          type: 'failed',
          agentId: 'agent-2',
          beadTitle: 'Fix auth',
          summary: 'timeout',
        }),
      )
      vi.advanceTimersByTime(1000)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      expect(msg).toContain('agent-2')
      expect(msg).toContain('[Fix auth]')
      expect(msg).toContain('timeout')
      expect(msg).toContain('❌')
    })
  })

  // ── Batching ────────────────────────────────────────────────────────────

  describe('batching', () => {
    it('batches events within 1s window into single sendMessage', () => {
      createBridge('all')
      for (let i = 0; i < 5; i++) {
        orchestrator.emit('activity', makeEvent({ type: 'completed', beadId: `sb-${i}` }))
      }
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      const lines = msg.split('\n')
      expect(lines).toHaveLength(5)
    })

    it('sends separate batches for events in different windows', () => {
      createBridge('all')
      orchestrator.emit('activity', makeEvent({ type: 'started' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)

      orchestrator.emit('activity', makeEvent({ type: 'completed' }))
      vi.advanceTimersByTime(1000)
      expect(bot.sendMessage).toHaveBeenCalledTimes(2)
    })
  })

  // ── Output cap ──────────────────────────────────────────────────────────

  describe('output forwarding', () => {
    it('truncates output > 500 chars', () => {
      createBridge('all')
      const longChunk = 'x'.repeat(600)
      orchestrator.emit('output', 'agent-0', longChunk)
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      expect(msg.length).toBeLessThanOrEqual(500 + 10) // emoji prefix + ellipsis
      expect(msg).toContain('…')
    })

    it('does not truncate short output', () => {
      createBridge('all')
      orchestrator.emit('output', 'agent-0', 'hello world')
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)
      const msg = bot.sendMessage.mock.calls[0][0] as string
      expect(msg).toContain('hello world')
      expect(msg).not.toContain('…')
    })
  })

  // ── 30s output throttle ─────────────────────────────────────────────────

  describe('output throttle', () => {
    it('suppresses output within 30s window', () => {
      createBridge('all')
      orchestrator.emit('output', 'agent-0', 'first')
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)

      // Within 30s window — should be suppressed
      vi.advanceTimersByTime(5000)
      orchestrator.emit('output', 'agent-0', 'second')
      expect(bot.sendMessage).toHaveBeenCalledTimes(1)

      // After 30s — should go through
      vi.advanceTimersByTime(30_000)
      orchestrator.emit('output', 'agent-0', 'third')
      expect(bot.sendMessage).toHaveBeenCalledTimes(2)
    })

    it('suppresses output when notifyOn is none', () => {
      createBridge('none')
      orchestrator.emit('output', 'agent-0', 'hello')
      expect(bot.sendMessage).not.toHaveBeenCalled()
    })
  })

  // ── Command routing ─────────────────────────────────────────────────────

  describe('command routing', () => {
    it('routes /plan to orchestrator.injectPlan', () => {
      createBridge('all')
      const handler = bot._handlers.get('plan')!
      handler('add auth feature', '123')
      expect(orchestrator.injectPlan).toHaveBeenCalledWith('add auth feature')
    })

    it('routes /bead to bdClient.create', () => {
      createBridge('all')
      const handler = bot._handlers.get('bead')!
      handler('Fix login bug', '123')
      expect(orchestrator.coordinator.bdClient.create).toHaveBeenCalledWith({
        title: 'Fix login bug',
      })
    })

    it('routes /pause to pauseAllWorkers', () => {
      createBridge('all')
      bot._handlers.get('pause')!('', '123')
      expect(orchestrator.pauseAllWorkers).toHaveBeenCalled()
    })

    it('routes /resume to resumeAllWorkers', () => {
      createBridge('all')
      bot._handlers.get('resume')!('', '123')
      expect(orchestrator.resumeAllWorkers).toHaveBeenCalled()
    })

    it('routes /stop to gracefulStopWorkers', () => {
      createBridge('all')
      bot._handlers.get('stop')!('', '123')
      expect(orchestrator.gracefulStopWorkers).toHaveBeenCalled()
    })

    it('routes /status and sends bot status', () => {
      createBridge('all')
      bot._handlers.get('status')!('', '123')
      expect(bot.getStatus).toHaveBeenCalled()
      expect(bot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('@testbot'))
    })

    it('sends usage message when /plan has no args', () => {
      createBridge('all')
      bot._handlers.get('plan')!('', '123')
      expect(orchestrator.injectPlan).not.toHaveBeenCalled()
      expect(bot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Usage'))
    })

    it('sends usage message when /bead has no args', () => {
      createBridge('all')
      bot._handlers.get('bead')!('', '123')
      expect(orchestrator.coordinator.bdClient.create).not.toHaveBeenCalled()
      expect(bot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Usage'))
    })
  })

  // ── Lifecycle ───────────────────────────────────────────────────────────

  describe('start/stop lifecycle', () => {
    it('adds listeners on start and removes on stop', () => {
      bridge = new TelegramBridge({
        orchestrator: orchestrator as any,
        bot: bot as any,
        notifyOn: 'all',
        logger: () => {},
      })

      expect(orchestrator.listenerCount('activity')).toBe(0)
      expect(orchestrator.listenerCount('output')).toBe(0)

      bridge.start()
      expect(orchestrator.listenerCount('activity')).toBe(1)
      expect(orchestrator.listenerCount('output')).toBe(1)

      bridge.stop()
      expect(orchestrator.listenerCount('activity')).toBe(0)
      expect(orchestrator.listenerCount('output')).toBe(0)
    })

    it('clears batch timer on stop', () => {
      createBridge('all')
      orchestrator.emit('activity', makeEvent({ type: 'completed' }))
      // Timer is now pending
      bridge.stop()
      // Advancing time should NOT trigger sendMessage
      vi.advanceTimersByTime(2000)
      expect(bot.sendMessage).not.toHaveBeenCalled()
    })
  })
})
