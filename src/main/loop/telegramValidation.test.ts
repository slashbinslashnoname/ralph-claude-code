import { describe, it, expect } from 'vitest'
import { validateTelegramProjectPath, validateTelegramConfigure } from './telegramValidation'

describe('validateTelegramProjectPath', () => {
  it('accepts a valid absolute path', () => {
    expect(validateTelegramProjectPath('/tmp/project')).toBe('/tmp/project')
  })

  it('rejects non-string input', () => {
    expect(() => validateTelegramProjectPath(123)).toThrow('must be a non-empty string')
    expect(() => validateTelegramProjectPath(null)).toThrow('must be a non-empty string')
    expect(() => validateTelegramProjectPath(undefined)).toThrow('must be a non-empty string')
  })

  it('rejects relative paths', () => {
    expect(() => validateTelegramProjectPath('relative/path')).toThrow('must be an absolute path')
  })
})

describe('validateTelegramConfigure', () => {
  const validOpts = {
    botToken: '123456:ABCdefGHIjklMNOpqrSTUvwx',
    chatId: '-100123456789',
    notifyLevel: 'all',
  }

  it('accepts valid configuration', () => {
    const result = validateTelegramConfigure('/tmp/project', validOpts)
    expect(result).toEqual({
      projectPath: '/tmp/project',
      botToken: '123456:ABCdefGHIjklMNOpqrSTUvwx',
      chatId: '-100123456789',
      notifyLevel: 'all',
    })
  })

  it('defaults notifyLevel to errors when omitted', () => {
    const result = validateTelegramConfigure('/tmp/project', {
      botToken: '123456:ABCdef',
      chatId: '12345',
    })
    expect(result.notifyLevel).toBe('errors')
  })

  it('rejects missing opts', () => {
    expect(() => validateTelegramConfigure('/tmp/project', null)).toThrow('must be an object')
    expect(() => validateTelegramConfigure('/tmp/project', 'string')).toThrow('must be an object')
  })

  it('rejects missing botToken', () => {
    expect(() => validateTelegramConfigure('/tmp/project', { chatId: '123' })).toThrow('botToken is required')
  })

  it('rejects invalid botToken format', () => {
    expect(() => validateTelegramConfigure('/tmp/project', {
      botToken: 'invalid-token',
      chatId: '123',
    })).toThrow('botToken format is invalid')
  })

  it('rejects missing chatId', () => {
    expect(() => validateTelegramConfigure('/tmp/project', {
      botToken: '123456:ABCdef',
    })).toThrow('chatId is required')
  })

  it('rejects non-numeric chatId', () => {
    expect(() => validateTelegramConfigure('/tmp/project', {
      botToken: '123456:ABCdef',
      chatId: 'not-a-number',
    })).toThrow('chatId must be a numeric string')
  })

  it('accepts negative chatId (group chats)', () => {
    const result = validateTelegramConfigure('/tmp/project', {
      botToken: '123456:ABCdef',
      chatId: '-12345',
    })
    expect(result.chatId).toBe('-12345')
  })

  it('rejects invalid notifyLevel', () => {
    expect(() => validateTelegramConfigure('/tmp/project', {
      botToken: '123456:ABCdef',
      chatId: '123',
      notifyLevel: 'invalid',
    })).toThrow('notifyLevel must be one of')
  })

  it('accepts all valid notifyLevel values', () => {
    for (const level of ['all', 'errors', 'completions', 'none']) {
      const result = validateTelegramConfigure('/tmp/project', {
        botToken: '123456:ABCdef',
        chatId: '123',
        notifyLevel: level,
      })
      expect(result.notifyLevel).toBe(level)
    }
  })
})
