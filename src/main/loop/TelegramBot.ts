import { Telegraf } from 'telegraf'
import type { TelegramConfig, TelegramStatus } from '../types'

type CommandHandler = (args: string, chatId: string) => void | Promise<void>

const MAX_MESSAGE_LENGTH = 4000
const THROTTLE_MS = 1000
const DISCONNECT_TIMEOUT_MS = 3000
const VALID_COMMANDS = ['bead', 'plan', 'status', 'pause', 'resume', 'stop', 'start', 'beads'] as const
type ValidCommand = (typeof VALID_COMMANDS)[number]

const COMMAND_MENU = [
  { command: 'start', description: 'Start workers: /start [1-10]' },
  { command: 'status', description: 'Show swarm status and bot info' },
  { command: 'beads', description: 'List current open beads' },
  { command: 'bead', description: 'Create a new bead: /bead <title>' },
  { command: 'plan', description: 'Inject a new plan: /plan <description>' },
  { command: 'pause', description: 'Pause all workers' },
  { command: 'resume', description: 'Resume all workers' },
  { command: 'stop', description: 'Gracefully stop all workers' },
] as const

function maskToken(token: string): string {
  if (token.length <= 5) return '*'.repeat(token.length)
  return token.slice(0, 5) + '*'.repeat(token.length - 5)
}

export class TelegramBot {
  private bot: Telegraf | null = null
  private config: TelegramConfig | null = null
  private _connected = false
  private _botUsername: string | null = null
  private _lastError: string | null = null
  private _messagesSent = 0
  private _messagesReceived = 0
  private _lastSendTime = 0
  private commandHandlers = new Map<string, CommandHandler>()
  private logger: (msg: string) => void

  constructor(logger?: (msg: string) => void) {
    this.logger = logger ?? console.log
  }

  async connect(config: TelegramConfig): Promise<void> {
    if (!config.botToken || !config.chatId) {
      throw new Error('botToken and chatId are required')
    }

    this.config = config
    const masked = maskToken(config.botToken)
    this.logger(`[telegram] connecting with token ${masked}`)

    try {
      this.bot = new Telegraf(config.botToken)
      const me = await this.bot.telegram.getMe()
      this._botUsername = me.username ?? null
      this._connected = true
      this._lastError = null
      this.logger(`[telegram] connected as @${this._botUsername}`)

      // Register command menu with Telegram
      try {
        await this.bot.telegram.setMyCommands(COMMAND_MENU as unknown as Array<{ command: string; description: string }>)
        this.logger('[telegram] command menu registered')
      } catch (err) {
        this.logger(`[telegram] failed to register command menu: ${err}`)
      }

      // Register command listeners on the bot
      for (const cmd of VALID_COMMANDS) {
        this.bot.command(cmd, async (ctx) => {
          const incomingChatId = String(ctx.chat.id)
          if (incomingChatId !== this.config!.chatId) {
            this.logger(`[telegram] ignoring command /${cmd} from unauthorized chat ${incomingChatId}`)
            return
          }
          this._messagesReceived++
          const handler = this.commandHandlers.get(cmd)
          if (handler) {
            const args = ctx.message.text.replace(`/${cmd}`, '').trim()
            await handler(args, incomingChatId)
          }
        })
      }

      // Launch bot (non-blocking polling)
      this.bot.launch().catch((err) => {
        this._lastError = String(err)
        this._connected = false
        this.logger(`[telegram] polling error: ${this._lastError}`)
      })
    } catch (err) {
      this._lastError = String(err)
      this._connected = false
      this.logger(`[telegram] connect failed: ${this._lastError}`)
      throw err
    }
  }

  async disconnect(): Promise<void> {
    if (!this.bot) return

    const bot = this.bot
    this.bot = null
    this._connected = false

    try {
      await Promise.race([
        bot.stop('disconnect'),
        new Promise<void>((resolve) => setTimeout(resolve, DISCONNECT_TIMEOUT_MS)),
      ])
    } catch {
      // swallow errors on shutdown
    }

    this.logger('[telegram] disconnected')
  }

  async sendMessage(text: string): Promise<boolean> {
    if (!this.bot || !this.config || !this._connected) {
      return false
    }

    const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text

    // Throttle: ensure at least THROTTLE_MS between sends
    const now = Date.now()
    const elapsed = now - this._lastSendTime
    if (elapsed < THROTTLE_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, THROTTLE_MS - elapsed))
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.bot.telegram.sendMessage(this.config.chatId, truncated)
        this._messagesSent++
        this._lastSendTime = Date.now()
        return true
      } catch (err) {
        this._lastError = String(err)
        if (attempt === 0) {
          this.logger(`[telegram] send failed, retrying: ${this._lastError}`)
        } else {
          this.logger(`[telegram] send failed after retry: ${this._lastError}`)
        }
      }
    }
    return false
  }

  onCommand(command: ValidCommand, handler: CommandHandler): void {
    if (!VALID_COMMANDS.includes(command)) {
      throw new Error(`Invalid command: ${command}. Valid: ${VALID_COMMANDS.join(', ')}`)
    }
    this.commandHandlers.set(command, handler)
  }

  isConnected(): boolean {
    return this._connected
  }

  getStatus(): TelegramStatus {
    return {
      connected: this._connected,
      botUsername: this._botUsername,
      lastError: this._lastError,
      messagesSent: this._messagesSent,
      messagesReceived: this._messagesReceived,
    }
  }
}
