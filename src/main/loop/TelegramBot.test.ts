import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock telegraf before importing TelegramBot
const mockGetMe = vi.fn()
const mockSendMessage = vi.fn()
const mockCommand = vi.fn()
const mockLaunch = vi.fn()
const mockStop = vi.fn()

vi.mock('telegraf', () => ({
  Telegraf: vi.fn().mockImplementation(function () {
    return {
      telegram: {
        getMe: mockGetMe,
        sendMessage: mockSendMessage,
      },
      command: mockCommand,
      launch: mockLaunch,
      stop: mockStop,
    }
  }),
}))

import { TelegramBot } from './TelegramBot'
import type { TelegramConfig } from '../types'

const validConfig: TelegramConfig = {
  botToken: '12345:ABCDEF_ghijklmnop',
  chatId: '999888777',
  enabled: true,
  notifyOn: 'all',
}

describe('TelegramBot', () => {
  let bot: TelegramBot
  let logs: string[]

  beforeEach(() => {
    vi.clearAllMocks()
    logs = []
    bot = new TelegramBot((msg) => logs.push(msg))
    mockGetMe.mockResolvedValue({ username: 'testbot' })
    mockLaunch.mockResolvedValue(undefined)
    mockStop.mockResolvedValue(undefined)
    mockSendMessage.mockResolvedValue({})
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('connect', () => {
    it('validates with getMe and sets connected state', async () => {
      await bot.connect(validConfig)
      expect(mockGetMe).toHaveBeenCalled()
      expect(bot.isConnected()).toBe(true)
      expect(bot.getStatus().botUsername).toBe('testbot')
    })

    it('throws on missing botToken', async () => {
      await expect(bot.connect({ ...validConfig, botToken: '' })).rejects.toThrow('botToken and chatId are required')
    })

    it('throws on missing chatId', async () => {
      await expect(bot.connect({ ...validConfig, chatId: '' })).rejects.toThrow('botToken and chatId are required')
    })

    it('handles getMe failure', async () => {
      mockGetMe.mockRejectedValue(new Error('Unauthorized'))
      await expect(bot.connect(validConfig)).rejects.toThrow('Unauthorized')
      expect(bot.isConnected()).toBe(false)
      expect(bot.getStatus().lastError).toContain('Unauthorized')
    })

    it('registers command listeners for all valid commands', async () => {
      await bot.connect(validConfig)
      expect(mockCommand).toHaveBeenCalledTimes(6) // bead, plan, status, pause, resume, stop
      const registeredCmds = mockCommand.mock.calls.map((c) => c[0])
      expect(registeredCmds).toEqual(['bead', 'plan', 'status', 'pause', 'resume', 'stop'])
    })
  })

  describe('token masking', () => {
    it('masks token in logs, showing only first 5 chars', async () => {
      await bot.connect(validConfig)
      const connectLog = logs.find((l) => l.includes('connecting with token'))
      expect(connectLog).toBeDefined()
      // Should show first 5 chars then stars
      expect(connectLog).toContain('12345')
      expect(connectLog).not.toContain(':ABCDEF')
      expect(connectLog).not.toContain(validConfig.botToken)
    })
  })

  describe('disconnect', () => {
    it('stops the bot and sets connected to false', async () => {
      await bot.connect(validConfig)
      expect(bot.isConnected()).toBe(true)
      await bot.disconnect()
      expect(bot.isConnected()).toBe(false)
      expect(mockStop).toHaveBeenCalledWith('disconnect')
    })

    it('handles disconnect when not connected', async () => {
      await bot.disconnect() // should not throw
      expect(bot.isConnected()).toBe(false)
    })

    it('completes within timeout when stop hangs', async () => {
      await bot.connect(validConfig)
      mockStop.mockReturnValue(new Promise(() => {})) // never resolves

      const start = Date.now()
      await bot.disconnect()
      const elapsed = Date.now() - start

      expect(bot.isConnected()).toBe(false)
      // Should complete within ~3s + some tolerance
      expect(elapsed).toBeLessThan(5000)
    }, 10000)
  })

  describe('sendMessage', () => {
    it('sends a message to the configured chatId', async () => {
      await bot.connect(validConfig)
      const result = await bot.sendMessage('hello')
      expect(result).toBe(true)
      expect(mockSendMessage).toHaveBeenCalledWith('999888777', 'hello')
      expect(bot.getStatus().messagesSent).toBe(1)
    })

    it('truncates messages to 4000 chars', async () => {
      await bot.connect(validConfig)
      const longMsg = 'x'.repeat(5000)
      await bot.sendMessage(longMsg)
      const sentText = mockSendMessage.mock.calls[0][1]
      expect(sentText.length).toBe(4000)
    })

    it('retries once on failure then succeeds', async () => {
      await bot.connect(validConfig)
      mockSendMessage.mockRejectedValueOnce(new Error('network error')).mockResolvedValueOnce({})
      const result = await bot.sendMessage('hello')
      expect(result).toBe(true)
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
      expect(bot.getStatus().messagesSent).toBe(1)
    })

    it('returns false after both attempts fail', async () => {
      await bot.connect(validConfig)
      mockSendMessage.mockRejectedValue(new Error('permanent error'))
      const result = await bot.sendMessage('hello')
      expect(result).toBe(false)
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
      expect(bot.getStatus().messagesSent).toBe(0)
    })

    it('returns false when not connected', async () => {
      const result = await bot.sendMessage('hello')
      expect(result).toBe(false)
    })

    it('throttles to 1 msg/s', async () => {
      vi.useFakeTimers()
      await bot.connect(validConfig)

      // Send first message
      const p1 = bot.sendMessage('first')
      await vi.advanceTimersByTimeAsync(0)
      await p1

      // Send second message immediately — should be delayed
      const p2 = bot.sendMessage('second')
      // Advance past throttle
      await vi.advanceTimersByTimeAsync(1000)
      await p2

      expect(mockSendMessage).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })
  })

  describe('onCommand', () => {
    it('registers a handler that gets called for matching commands', async () => {
      const handler = vi.fn()
      bot.onCommand('status', handler)
      await bot.connect(validConfig)

      // Simulate a command by calling the registered handler on mockCommand
      const statusCall = mockCommand.mock.calls.find((c) => c[0] === 'status')
      expect(statusCall).toBeDefined()

      const ctx = {
        chat: { id: 999888777 },
        message: { text: '/status some args' },
      }
      await statusCall![1](ctx)

      expect(handler).toHaveBeenCalledWith('some args', '999888777')
    })

    it('rejects unauthorized chatId', async () => {
      const handler = vi.fn()
      bot.onCommand('status', handler)
      await bot.connect(validConfig)

      const statusCall = mockCommand.mock.calls.find((c) => c[0] === 'status')
      const ctx = {
        chat: { id: 123456 }, // wrong chatId
        message: { text: '/status' },
      }
      await statusCall![1](ctx)

      expect(handler).not.toHaveBeenCalled()
      expect(logs.some((l) => l.includes('unauthorized'))).toBe(true)
    })

    it('increments messagesReceived for authorized commands', async () => {
      bot.onCommand('bead', vi.fn())
      await bot.connect(validConfig)

      const beadCall = mockCommand.mock.calls.find((c) => c[0] === 'bead')
      const ctx = {
        chat: { id: 999888777 },
        message: { text: '/bead abc' },
      }
      await beadCall![1](ctx)

      expect(bot.getStatus().messagesReceived).toBe(1)
    })

    it('does not increment messagesReceived for unauthorized messages', async () => {
      bot.onCommand('bead', vi.fn())
      await bot.connect(validConfig)

      const beadCall = mockCommand.mock.calls.find((c) => c[0] === 'bead')
      const ctx = {
        chat: { id: 111 },
        message: { text: '/bead abc' },
      }
      await beadCall![1](ctx)

      expect(bot.getStatus().messagesReceived).toBe(0)
    })
  })

  describe('getStatus', () => {
    it('returns correct initial status', () => {
      const status = bot.getStatus()
      expect(status).toEqual({
        connected: false,
        botUsername: null,
        lastError: null,
        messagesSent: 0,
        messagesReceived: 0,
      })
    })

    it('returns correct status after connect and send', async () => {
      await bot.connect(validConfig)
      await bot.sendMessage('test')
      const status = bot.getStatus()
      expect(status.connected).toBe(true)
      expect(status.botUsername).toBe('testbot')
      expect(status.messagesSent).toBe(1)
    })
  })
})
