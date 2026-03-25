import { EventEmitter } from 'events'
import type { TelegramBot } from './TelegramBot'
import type { BdClient } from './BdClient'
import type { ActivityEvent, BeadStats, TelegramNotifyLevel } from '../types'

type SwarmOrchestrator = EventEmitter & {
  injectPlan(request: string): { id: string }
  pauseAllWorkers(): void
  resumeAllWorkers(): void
  gracefulStopWorkers(): void
  startWorkers(n?: number): Promise<void>
  getStats(): Promise<BeadStats>
  coordinator: { bdClient: BdClient }
}

const EMOJI: Record<ActivityEvent['type'], string> = {
  started: '🟢',
  thinking: '🧠',
  claimed: '📋',
  executing: '⚙️',
  merged: '🔀',
  completed: '✅',
  failed: '❌',
  stopped: '🛑',
  paused: '⏸️',
  resumed: '▶️',
  rollback: '↩️',
  split: '✂️',
  heartbeat: '💓',
  dead_agent: '💀',
  claim_timeout: '⏰',
  info: 'ℹ️',
  circuit_open: '🔴',
  circuit_closed: '🟢',
}

const BATCH_WINDOW_MS = 1000
const OUTPUT_CAP_CHARS = 3000
const OUTPUT_THROTTLE_MS = 30_000

/**
 * Extract human-readable text from a Claude output chunk.
 * When --output-format json is used, Claude emits JSONL with typed objects.
 * We extract only meaningful text content (assistant messages, results).
 */
function extractReadableText(chunk: string): string {
  const lines = chunk.split('\n')
  const textParts: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      // Not JSON — pass through as-is (text-mode output or plain messages)
      if (trimmed) textParts.push(trimmed)
      continue
    }
    try {
      const obj = JSON.parse(trimmed)
      if (obj.type === 'assistant' && typeof obj.message === 'string') {
        textParts.push(obj.message)
      } else if (obj.type === 'assistant' && obj.message?.content) {
        // assistant messages with content blocks
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) textParts.push(block.text)
        }
      } else if (obj.type === 'result' && typeof obj.result === 'string') {
        textParts.push(obj.result)
      }
      // Skip system, tool_use, tool_result, etc. — not useful for Telegram
    } catch {
      // Not valid JSON — include as-is if non-empty
      if (trimmed) textParts.push(trimmed)
    }
  }

  return textParts.join('\n')
}

/** Events that always notify regardless of level (critical system events) */
const CRITICAL_TYPES: Set<ActivityEvent['type']> = new Set(['circuit_open'])

/** Events considered "errors" for filtering */
const ERROR_TYPES: Set<ActivityEvent['type']> = new Set(['failed', 'rollback'])

/** Events considered "completions" (important milestones) */
const COMPLETION_TYPES: Set<ActivityEvent['type']> = new Set([
  'completed',
  'merged',
  'failed',
  'rollback',
  'stopped',
])

function shouldNotify(level: TelegramNotifyLevel, eventType: ActivityEvent['type']): boolean {
  if (CRITICAL_TYPES.has(eventType)) return true
  switch (level) {
    case 'all':
      return true
    case 'completions':
      return COMPLETION_TYPES.has(eventType)
    case 'errors':
      return ERROR_TYPES.has(eventType)
    case 'none':
      return false
    default:
      return false
  }
}

function formatEvent(event: ActivityEvent): string {
  const emoji = EMOJI[event.type] ?? '❓'
  if (event.type === 'circuit_open') {
    const summary = event.summary ?? 'unknown reason'
    return `🔴 Circuit OPEN — worker ${event.agentId}: ${summary}`
  }
  if (event.type === 'circuit_closed') {
    const summary = event.summary ?? 'recovered'
    return `🟢 Circuit CLOSED — worker ${event.agentId}: ${summary}`
  }
  const agent = event.agentId
  const bead = event.beadTitle ?? event.beadId ?? ''
  const beadPart = bead ? ` [${bead}]` : ''
  const summary = event.summary ? ` — ${event.summary}` : ''
  return `${emoji} ${agent}${beadPart} ${event.type}${summary}`
}

export class TelegramBridge {
  private orchestrator: SwarmOrchestrator
  private bot: TelegramBot
  private notifyOn: TelegramNotifyLevel
  private logger: (msg: string) => void

  // Batching state
  private batchBuffer: ActivityEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null

  // Output throttling
  private lastOutputTime = 0

  // Line buffer for reassembling split stdout chunks
  private lineBuffers = new Map<string, string>()

  // Bound listeners for cleanup
  private _onActivity: (event: ActivityEvent) => void
  private _onOutput: (agentId: string, chunk: string) => void

  constructor(opts: {
    orchestrator: SwarmOrchestrator
    bot: TelegramBot
    notifyOn?: TelegramNotifyLevel
    logger?: (msg: string) => void
  }) {
    this.orchestrator = opts.orchestrator
    this.bot = opts.bot
    this.notifyOn = opts.notifyOn ?? 'errors'
    this.logger = opts.logger ?? console.log

    this._onActivity = (event: ActivityEvent) => this._handleActivity(event)
    this._onOutput = (agentId: string, chunk: string) => this._handleOutput(agentId, chunk)
  }

  start(): void {
    this.orchestrator.on('activity', this._onActivity)
    this.orchestrator.on('output', this._onOutput)
    this._registerCommands()
    this.logger('[telegram-bridge] started')
  }

  stop(): void {
    this.orchestrator.off('activity', this._onActivity)
    this.orchestrator.off('output', this._onOutput)
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.batchBuffer = []
    this.lineBuffers.clear()
    this.logger('[telegram-bridge] stopped')
  }

  // ── Activity handling ───────────────────────────────────────────────────

  private _handleActivity(event: ActivityEvent): void {
    if (!shouldNotify(this.notifyOn, event.type)) return
    this.batchBuffer.push(event)
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this._flushBatch(), BATCH_WINDOW_MS)
    }
  }

  private _flushBatch(): void {
    this.batchTimer = null
    if (this.batchBuffer.length === 0) return

    const lines = this.batchBuffer.map(formatEvent)
    this.batchBuffer = []
    const message = lines.join('\n')
    this.bot.sendMessage(message).catch((err) => {
      this.logger(`[telegram-bridge] send failed: ${err}`)
    })
  }

  // ── Output forwarding ──────────────────────────────────────────────────

  private _handleOutput(agentId: string, chunk: string): void {
    if (this.notifyOn === 'none') return

    const now = Date.now()
    if (now - this.lastOutputTime < OUTPUT_THROTTLE_MS) return

    // Buffer chunks and process only complete lines to avoid split JSON
    const prev = this.lineBuffers.get(agentId) ?? ''
    const combined = prev + chunk
    const lastNewline = combined.lastIndexOf('\n')

    if (lastNewline < 0) {
      // No complete line yet — keep buffering
      this.lineBuffers.set(agentId, combined)
      return
    }

    // Process complete lines, keep remainder in buffer
    const completeLines = combined.slice(0, lastNewline)
    this.lineBuffers.set(agentId, combined.slice(lastNewline + 1))

    const readable = extractReadableText(completeLines)
    if (!readable) return // skip chunks with no human-readable content (e.g. tool_use JSON)

    this.lastOutputTime = now
    const truncated =
      readable.length > OUTPUT_CAP_CHARS ? readable.slice(0, OUTPUT_CAP_CHARS) + '…' : readable
    this.bot.sendMessage(`📝 ${agentId}: ${truncated}`).catch((err) => {
      this.logger(`[telegram-bridge] output send failed: ${err}`)
    })
  }

  // ── Command routing ────────────────────────────────────────────────────

  private _registerCommands(): void {
    this.bot.onCommand('plan', (args) => {
      if (!args) {
        this.bot.sendMessage('Usage: /plan <description>').catch(() => {})
        return
      }
      const { id } = this.orchestrator.injectPlan(args)
      this.bot.sendMessage(`📝 Plan queued: ${id}`).catch(() => {})
    })

    this.bot.onCommand('bead', (args) => {
      if (!args) {
        this.bot.sendMessage('Usage: /bead <title>').catch(() => {})
        return
      }
      try {
        const bead = this.orchestrator.coordinator.bdClient.create({ title: args })
        this.bot.sendMessage(`📋 Bead created: ${bead.id}`).catch(() => {})
      } catch (err) {
        this.bot.sendMessage(`❌ Failed to create bead: ${err}`).catch(() => {})
      }
    })

    this.bot.onCommand('pause', () => {
      this.orchestrator.pauseAllWorkers()
      this.bot.sendMessage('⏸️ All workers paused').catch(() => {})
    })

    this.bot.onCommand('resume', () => {
      this.orchestrator.resumeAllWorkers()
      this.bot.sendMessage('▶️ All workers resumed').catch(() => {})
    })

    this.bot.onCommand('stop', () => {
      this.orchestrator.gracefulStopWorkers()
      this.bot.sendMessage('🛑 Graceful stop initiated').catch(() => {})
    })

    this.bot.onCommand('start', async (args) => {
      let n: number | undefined
      if (args) {
        const parsed = parseInt(args, 10)
        if (isNaN(parsed) || parsed < 1 || parsed > 10) {
          this.bot.sendMessage('Usage: /start [1-10]').catch(() => {})
          return
        }
        n = parsed
      }
      try {
        await this.orchestrator.startWorkers(n)
        this.bot.sendMessage(`🚀 Started ${n ?? 'default'} worker(s)`).catch(() => {})
      } catch (err) {
        this.bot.sendMessage(`❌ Failed to start workers: ${err}`).catch(() => {})
      }
    })

    this.bot.onCommand('beads', async (args) => {
      if (!args) {
        try {
          const stats = await this.orchestrator.getStats()
          const lines = [
            '📊 Bead Stats',
            `Total: ${stats.total} | Done: ${stats.done} (${stats.pct}%)`,
            `Pending: ${stats.pending} | Ready: ${stats.ready}`,
            `Claimed: ${stats.claimed} | Failed: ${stats.failed}`,
          ]
          this.bot.sendMessage(lines.join('\n')).catch(() => {})
        } catch (err) {
          this.bot.sendMessage(`❌ Failed to get stats: ${err}`).catch(() => {})
        }
        return
      }

      const filter = args.trim().toLowerCase()
      const validFilters: Record<string, string[]> = {
        open: ['pending', 'ready'],
        active: ['claimed'],
        done: ['done', 'failed'],
      }
      if (!(filter in validFilters)) {
        this.bot.sendMessage('Usage: /beads [open|active|done]').catch(() => {})
        return
      }

      try {
        const all = this.orchestrator.coordinator.bdClient.listAll()
        const statuses = validFilters[filter]
        const matched = all.filter((b) => statuses.includes(b.status))
        const limit = 15
        const shown = matched.slice(0, limit)
        const lines = shown.map((b) => `• [${b.status}] ${b.id}: ${b.title}`)
        if (matched.length > limit) {
          lines.push(`… and ${matched.length - limit} more`)
        }
        if (lines.length === 0) {
          lines.push(`No ${filter} beads found.`)
        }
        this.bot.sendMessage(lines.join('\n')).catch(() => {})
      } catch (err) {
        this.bot.sendMessage(`❌ Failed to list beads: ${err}`).catch(() => {})
      }
    })

    this.bot.onCommand('status', () => {
      const status = this.bot.getStatus()
      const lines = [
        `🤖 Bot: @${status.botUsername ?? 'unknown'}`,
        `📨 Sent: ${status.messagesSent} | Received: ${status.messagesReceived}`,
        `🔗 Connected: ${status.connected}`,
      ]
      if (status.lastError) lines.push(`⚠️ Last error: ${status.lastError}`)
      this.bot.sendMessage(lines.join('\n')).catch(() => {})
    })
  }
}
