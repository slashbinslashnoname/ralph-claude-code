import { describe, it, expect } from 'vitest'
import type {
  TelegramConfig,
  TelegramStatus,
  TelegramNotifyLevel,
  RalphConfig,
  KnowledgeEntry,
  KnowledgeCategory,
  KnowledgeConfidence
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
      autoSplitThreshold: 3,
      buildMonitorCmd: '',
      buildMonitorInterval: 120,
      claudeModelThink: '',
      claudeModelExecute: '',
      claudeModelReview: ''
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

describe('KnowledgeEntry types', () => {
  it('KnowledgeCategory covers all expected values', () => {
    const categories: KnowledgeCategory[] = ['pattern', 'gotcha', 'dependency', 'convention', 'environment', 'risk']
    expect(categories).toHaveLength(6)
  })

  it('KnowledgeConfidence covers all expected values', () => {
    const levels: KnowledgeConfidence[] = ['high', 'medium', 'low']
    expect(levels).toHaveLength(3)
  })

  it('KnowledgeEntry accepts valid entry', () => {
    const entry: KnowledgeEntry = {
      ts: '2026-03-21T10:00:00Z',
      agentId: 'agent-0',
      beadId: 'sb-0o0.1',
      category: 'pattern',
      summary: 'Use worktrees for isolation',
      detail: 'Each agent should create a git worktree to avoid conflicts',
      confidence: 'high'
    }
    expect(entry.ts).toBe('2026-03-21T10:00:00Z')
    expect(entry.agentId).toBe('agent-0')
    expect(entry.beadId).toBe('sb-0o0.1')
    expect(entry.category).toBe('pattern')
    expect(entry.summary).toBe('Use worktrees for isolation')
    expect(entry.detail).toBe('Each agent should create a git worktree to avoid conflicts')
    expect(entry.confidence).toBe('high')
  })

  it('KnowledgeEntry works with all category values', () => {
    const categories: KnowledgeCategory[] = ['pattern', 'gotcha', 'dependency', 'convention', 'environment', 'risk']
    const entries: KnowledgeEntry[] = categories.map((cat) => ({
      ts: '2026-03-21T10:00:00Z',
      agentId: 'agent-1',
      beadId: 'sb-abc.1',
      category: cat,
      summary: `Test ${cat}`,
      detail: `Detail for ${cat}`,
      confidence: 'medium' as KnowledgeConfidence
    }))
    expect(entries).toHaveLength(6)
    entries.forEach((e, i) => {
      expect(e.category).toBe(categories[i])
    })
  })
})
