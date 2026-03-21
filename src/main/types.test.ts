import { describe, it, expect } from 'vitest'
import type {
  TelegramConfig,
  TelegramStatus,
  TelegramNotifyLevel,
  RalphConfig
} from './types'

describe('Telegram types', () => {
  it('TelegramConfig accepts valid configuration', () => {
    const config: TelegramConfig = {
      botToken: '123456:ABC-DEF',
      chatId: '-1001234567890',
      enabled: true,
      notifyOn: 'all'
    }
    expect(config.botToken).toBe('123456:ABC-DEF')
    expect(config.chatId).toBe('-1001234567890')
    expect(config.enabled).toBe(true)
    expect(config.notifyOn).toBe('all')
  })

  it('TelegramNotifyLevel covers all expected values', () => {
    const levels: TelegramNotifyLevel[] = ['all', 'errors', 'completions', 'none']
    expect(levels).toHaveLength(4)
  })

  it('TelegramStatus represents connected and disconnected states', () => {
    const connected: TelegramStatus = {
      connected: true,
      botUsername: 'my_bot',
      lastError: null,
      messagesSent: 42,
      messagesReceived: 7
    }
    expect(connected.connected).toBe(true)
    expect(connected.botUsername).toBe('my_bot')

    const disconnected: TelegramStatus = {
      connected: false,
      botUsername: null,
      lastError: 'Connection timeout',
      messagesSent: 0,
      messagesReceived: 0
    }
    expect(disconnected.connected).toBe(false)
    expect(disconnected.lastError).toBe('Connection timeout')
  })

  it('RalphConfig.telegram is optional', () => {
    const withoutTelegram: RalphConfig = {
      maxCallsPerHour: 100,
      claudeTimeoutMinutes: 15,
      claudeOutputFormat: 'json',
      claudeCodeCmd: 'claude',
      allowedTools: '*',
      sleepDuration: 3,
      continueSession: true,
      cbNoProgressThreshold: 3,
      cbSameErrorThreshold: 5,
      cbPermissionDenialThreshold: 2,
      cbCooldownMinutes: 30,
      autoPush: true,
      maxRetries: 2,
      autoSplitThreshold: 3
    }
    expect(withoutTelegram.telegram).toBeUndefined()

    const withTelegram: RalphConfig = {
      ...withoutTelegram,
      telegram: {
        botToken: 'token',
        chatId: 'chat',
        enabled: false,
        notifyOn: 'errors'
      }
    }
    expect(withTelegram.telegram?.enabled).toBe(false)
    expect(withTelegram.telegram?.notifyOn).toBe('errors')
  })
})
