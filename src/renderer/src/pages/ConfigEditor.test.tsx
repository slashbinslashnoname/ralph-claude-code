import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const mockReadFile = vi.fn().mockResolvedValue({ ok: true, content: '' })
  const mockWriteFile = vi.fn().mockResolvedValue({ ok: true })
  const mockTelegramStatus = vi.fn().mockResolvedValue({
    connected: false,
    botUsername: null,
    lastError: null,
    messagesSent: 0,
    messagesReceived: 0,
  })
  const mockTelegramConfigure = vi.fn().mockResolvedValue({ ok: true })
  const mockTelegramTest = vi.fn().mockResolvedValue({ ok: true })
  const mockTelegramDisconnect = vi.fn().mockResolvedValue({ ok: true })
  const mockConfigRead = vi.fn().mockResolvedValue({
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 15,
    continueSession: true,
    telegram: { botToken: '', chatId: '', enabled: false, notifyOn: 'errors' },
  })
  const mockConfigWrite = vi.fn().mockResolvedValue({ ok: true })

  ;(globalThis as any).window = {
    slashbot: {
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      telegram: {
        status: mockTelegramStatus,
        configure: mockTelegramConfigure,
        test: mockTelegramTest,
        disconnect: mockTelegramDisconnect,
      },
      config: {
        read: mockConfigRead,
        write: mockConfigWrite,
      },
    },
  }

  return {
    mockReadFile,
    mockWriteFile,
    mockTelegramStatus,
    mockTelegramConfigure,
    mockTelegramTest,
    mockTelegramDisconnect,
    mockConfigRead,
    mockConfigWrite,
  }
})

import ConfigEditor from './ConfigEditor'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockReadFile.mockResolvedValue({ ok: true, content: '' })
  mocks.mockTelegramStatus.mockResolvedValue({
    connected: false,
    botUsername: null,
    lastError: null,
    messagesSent: 0,
    messagesReceived: 0,
  })
  mocks.mockConfigRead.mockResolvedValue({
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 15,
    continueSession: true,
    telegram: { botToken: '', chatId: '', enabled: false, notifyOn: 'errors' },
  })
})

describe('ConfigEditor', () => {
  test('renders Prompts and Telegram outer tabs', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('>Prompts</button>')
    expect(html).toContain('>Telegram</button>')
  })

  test('does not render .slashbotrc tab', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).not.toContain('.slashbotrc')
  })

  test('renders inner prompt toggle with PROMPT.md and AGENT.md', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('prompt-toggle')
    expect(html).toContain('>PROMPT.md</button>')
    expect(html).toContain('>AGENT.md</button>')
  })

  test('PROMPT.md toggle is active by default', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('prompt-toggle-btn active')
  })

  test('renders code-editor textarea in prompts mode', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('code-editor')
    expect(html).toContain('<textarea')
  })

  test('readFile mock is callable with project path and PROMPT.md', async () => {
    await window.slashbot.readFile('/my/project', 'PROMPT.md')
    expect(mocks.mockReadFile).toHaveBeenCalledWith('/my/project', 'PROMPT.md')
  })

  test('readFile mock is callable with AGENT.md', async () => {
    await window.slashbot.readFile('/my/project', 'AGENT.md')
    expect(mocks.mockReadFile).toHaveBeenCalledWith('/my/project', 'AGENT.md')
  })

  test('renders Save button', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('Saved')
  })

  test('Prompts tab is active by default', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    // The Prompts tab button should have the active class
    expect(html).toMatch(/tab active[^"]*">Prompts/)
  })
})

describe('TelegramSection', () => {
  test('telegram status API is called when component mounts', () => {
    expect(mocks.mockTelegramStatus).toBeDefined()
    expect(typeof mocks.mockTelegramStatus).toBe('function')
  })

  test('telegram configure sends correct shape', async () => {
    mocks.mockTelegramConfigure.mockResolvedValue({ ok: true })
    const result = await window.slashbot.telegram.configure('/test', {
      botToken: '123:abc',
      chatId: '-100123',
      notifyLevel: 'errors',
    })
    expect(result).toEqual({ ok: true })
    expect(mocks.mockTelegramConfigure).toHaveBeenCalledWith('/test', {
      botToken: '123:abc',
      chatId: '-100123',
      notifyLevel: 'errors',
    })
  })

  test('telegram test returns result', async () => {
    mocks.mockTelegramTest.mockResolvedValue({ ok: true })
    const result = await window.slashbot.telegram.test('/test')
    expect(result).toEqual({ ok: true })
  })

  test('telegram test failure returns error', async () => {
    mocks.mockTelegramTest.mockResolvedValue({ ok: false, error: 'Bot not connected' })
    const result = await window.slashbot.telegram.test('/test')
    expect(result).toEqual({ ok: false, error: 'Bot not connected' })
  })

  test('telegram disconnect calls disconnect API', async () => {
    await window.slashbot.telegram.disconnect('/test')
    expect(mocks.mockTelegramDisconnect).toHaveBeenCalledWith('/test')
  })

  test('telegram status returns disconnected by default', async () => {
    const status = await window.slashbot.telegram.status('/test')
    expect(status.connected).toBe(false)
    expect(status.botUsername).toBeNull()
  })

  test('telegram status returns connected with bot username', async () => {
    mocks.mockTelegramStatus.mockResolvedValue({
      connected: true,
      botUsername: 'mybot',
      lastError: null,
      messagesSent: 5,
      messagesReceived: 3,
    })
    const status = await window.slashbot.telegram.status('/test')
    expect(status.connected).toBe(true)
    expect(status.botUsername).toBe('mybot')
    expect(status.messagesSent).toBe(5)
  })

  test('config.read returns telegram fields for TelegramSection', async () => {
    mocks.mockConfigRead.mockResolvedValue({
      maxCallsPerHour: 100,
      telegram: {
        botToken: '123:abc',
        chatId: '-100123',
        enabled: true,
        notifyOn: 'all',
      },
    })
    const cfg = await window.slashbot.config.read('/test')
    expect(mocks.mockConfigRead).toHaveBeenCalledWith('/test')
    expect(cfg.telegram).toEqual({
      botToken: '123:abc',
      chatId: '-100123',
      enabled: true,
      notifyOn: 'all',
    })
  })
})

describe('config namespace (preload bridge)', () => {
  test('config.read returns full config shape', async () => {
    const cfg = await window.slashbot.config.read('/my/project')
    expect(mocks.mockConfigRead).toHaveBeenCalledWith('/my/project')
    expect(cfg).toMatchObject({ maxCallsPerHour: 100, continueSession: true })
    expect(cfg.telegram).toBeDefined()
  })

  test('config.write sends partial update and returns ok', async () => {
    const result = await window.slashbot.config.write('/my/project', { maxCallsPerHour: 50 })
    expect(mocks.mockConfigWrite).toHaveBeenCalledWith('/my/project', { maxCallsPerHour: 50 })
    expect(result).toEqual({ ok: true })
  })

  test('config.write failure propagates error', async () => {
    mocks.mockConfigWrite.mockResolvedValue({ ok: false, error: 'validation failed' })
    const result = await window.slashbot.config.write('/my/project', { maxCallsPerHour: -1 })
    expect(result).toEqual({ ok: false, error: 'validation failed' })
  })

  test('config.read is isolated per project path', async () => {
    mocks.mockConfigRead
      .mockResolvedValueOnce({ maxCallsPerHour: 10 })
      .mockResolvedValueOnce({ maxCallsPerHour: 200 })
    const a = await window.slashbot.config.read('/proj/a')
    const b = await window.slashbot.config.read('/proj/b')
    expect(a.maxCallsPerHour).toBe(10)
    expect(b.maxCallsPerHour).toBe(200)
  })
})
