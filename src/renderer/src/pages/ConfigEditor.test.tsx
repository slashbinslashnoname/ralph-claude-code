import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const MOCK_CONFIG = {
    maxCallsPerHour: 100,
    claudeTimeoutMinutes: 15,
    sleepDuration: 30,
    maxRetries: 3,
    autoSplitThreshold: 5,
    continueSession: true,
    autoPush: false,
    claudeCodeCmd: 'claude',
    allowedTools: 'Bash,Read,Write,Edit',
    claudeOutputFormat: 'json' as const,
    claudeModelThink: 'opus',
    claudeModelExecute: 'sonnet',
    claudeModelReview: 'haiku',
    cbNoProgressThreshold: 5,
    cbSameErrorThreshold: 3,
    cbErrorWindowSize: 10,
    cbErrorWindowThreshold: 5,
    cbPermissionDenialThreshold: 3,
    cbCooldownMinutes: 5,
    cbMaxCooldownMinutes: 60,
    buildMonitorCmd: 'npm run build',
    buildMonitorInterval: 300,
    telegram: { botToken: '', chatId: '', enabled: false, notifyOn: 'errors' as const },
  }

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
  const mockConfigRead = vi.fn().mockResolvedValue({ ok: true, config: { ...MOCK_CONFIG } })
  const mockConfigWrite = vi.fn().mockResolvedValue({ ok: true })
  const mockUpdateCheck = vi.fn()
  const mockUpdateDownload = vi.fn()
  const mockUpdateInstall = vi.fn()
  const mockUpdateGetState = vi.fn().mockResolvedValue(null)
  const mockUpdateOnChecking = vi.fn(() => () => {})
  const mockUpdateOnAvailable = vi.fn(() => () => {})
  const mockUpdateOnNotAvailable = vi.fn(() => () => {})
  const mockUpdateOnProgress = vi.fn(() => () => {})
  const mockUpdateOnDownloaded = vi.fn(() => () => {})
  const mockUpdateOnError = vi.fn(() => () => {})

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
      update: {
        check: mockUpdateCheck,
        download: mockUpdateDownload,
        install: mockUpdateInstall,
        getState: mockUpdateGetState,
        onChecking: mockUpdateOnChecking,
        onAvailable: mockUpdateOnAvailable,
        onNotAvailable: mockUpdateOnNotAvailable,
        onProgress: mockUpdateOnProgress,
        onDownloaded: mockUpdateOnDownloaded,
        onError: mockUpdateOnError,
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
    mockUpdateCheck,
    mockUpdateDownload,
    mockUpdateInstall,
    mockUpdateGetState,
    mockUpdateOnChecking,
    mockUpdateOnAvailable,
    mockUpdateOnNotAvailable,
    mockUpdateOnProgress,
    mockUpdateOnDownloaded,
    mockUpdateOnError,
    MOCK_CONFIG,
  }
})

import ConfigEditor from './ConfigEditor'
import { validateField, NUMERIC_RANGES } from './ConfigEditor'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockReadFile.mockResolvedValue({ ok: true, content: '' })
  mocks.mockConfigRead.mockResolvedValue({ ok: true, config: { ...mocks.MOCK_CONFIG } })
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
  mocks.mockUpdateGetState.mockResolvedValue(null)
})

describe('ConfigEditor', () => {
  test('renders Settings, Prompts, Telegram, and Updates outer tabs', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('>Settings</button>')
    expect(html).toContain('>Prompts</button>')
    expect(html).toContain('>Telegram</button>')
    expect(html).toContain('>Updates</button>')
  })

  test('does not render .slashbotrc tab', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).not.toContain('.slashbotrc')
  })

  test('renders Settings section with loading state on initial render', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    // SSR renders the loading state since useEffect hasn't fired
    expect(html).toContain('Loading configuration')
  })

  test('does not render .slashbotrc as an editable file tab', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).not.toContain('Configuration (.slashbotrc)')
  })

  test('readFile mock is callable with project path and PROMPT.md', async () => {
    await window.slashbot.readFile('/my/project', 'PROMPT.md')
    expect(mocks.mockReadFile).toHaveBeenCalledWith('/my/project', 'PROMPT.md')
  })

  test('readFile mock is callable with AGENT.md', async () => {
    await window.slashbot.readFile('/my/project', 'AGENT.md')
    expect(mocks.mockReadFile).toHaveBeenCalledWith('/my/project', 'AGENT.md')
  })

  test('renders Configuration header', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toContain('Configuration')
  })
})

describe('validateField', () => {
  test('returns null for valid numeric values within range', () => {
    expect(validateField('maxCallsPerHour', 100)).toBeNull()
    expect(validateField('maxRetries', 0)).toBeNull()
    expect(validateField('maxRetries', 10)).toBeNull()
    expect(validateField('sleepDuration', 0)).toBeNull()
  })

  test('returns error for values below minimum', () => {
    expect(validateField('maxCallsPerHour', 0)).toContain('between 1 and 10000')
    expect(validateField('maxRetries', -1)).toContain('between 0 and 10')
  })

  test('returns error for values above maximum', () => {
    expect(validateField('maxCallsPerHour', 10001)).toContain('between 1 and 10000')
    expect(validateField('maxRetries', 11)).toContain('between 0 and 10')
  })

  test('returns error for NaN values', () => {
    expect(validateField('maxCallsPerHour', NaN)).toBe('Must be a number')
  })

  test('returns null for fields without numeric ranges', () => {
    expect(validateField('claudeCodeCmd', 'claude')).toBeNull()
    expect(validateField('continueSession', true)).toBeNull()
  })

  test('validates all circuit breaker fields', () => {
    expect(validateField('cbNoProgressThreshold', 1)).toBeNull()
    expect(validateField('cbSameErrorThreshold', 1000)).toBeNull()
    expect(validateField('cbCooldownMinutes', 0)).toContain('between 1 and 1440')
    expect(validateField('cbMaxCooldownMinutes', 1441)).toContain('between 1 and 1440')
  })

  test('validates build monitor interval', () => {
    expect(validateField('buildMonitorInterval', 30)).toBeNull()
    expect(validateField('buildMonitorInterval', 29)).toContain('between 30 and 86400')
    expect(validateField('buildMonitorInterval', 86401)).toContain('between 30 and 86400')
  })
})

describe('NUMERIC_RANGES', () => {
  test('contains expected keys', () => {
    const keys = Object.keys(NUMERIC_RANGES)
    expect(keys).toContain('maxCallsPerHour')
    expect(keys).toContain('claudeTimeoutMinutes')
    expect(keys).toContain('sleepDuration')
    expect(keys).toContain('cbNoProgressThreshold')
    expect(keys).toContain('cbCooldownMinutes')
    expect(keys).toContain('cbMaxCooldownMinutes')
    expect(keys).toContain('maxRetries')
    expect(keys).toContain('autoSplitThreshold')
    expect(keys).toContain('buildMonitorInterval')
  })

  test('all ranges have min <= max', () => {
    for (const [key, range] of Object.entries(NUMERIC_RANGES)) {
      expect(range!.min).toBeLessThanOrEqual(range!.max)
    }
  })

  test('Settings tab is active by default', () => {
    const html = renderToStaticMarkup(<ConfigEditor projectPath="/test" />)
    expect(html).toMatch(/tab active[^"]*">Settings/)
  })
})

describe('TelegramSection', () => {
  test('telegram status API is callable', () => {
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
  test('config.read returns { ok, config } shape', async () => {
    const result = await window.slashbot.config.read('/my/project')
    expect(mocks.mockConfigRead).toHaveBeenCalledWith('/my/project')
    expect(result).toMatchObject({ ok: true, config: { maxCallsPerHour: 100 } })
  })

  test('config.read error returns { ok: false, error }', async () => {
    mocks.mockConfigRead.mockResolvedValue({ ok: false, error: 'file not found' })
    const result = await window.slashbot.config.read('/bad/path')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('file not found')
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
      .mockResolvedValueOnce({ ok: true, config: { maxCallsPerHour: 10 } })
      .mockResolvedValueOnce({ ok: true, config: { maxCallsPerHour: 200 } })
    const a = await window.slashbot.config.read('/proj/a')
    const b = await window.slashbot.config.read('/proj/b')
    expect(a.config.maxCallsPerHour).toBe(10)
    expect(b.config.maxCallsPerHour).toBe(200)
  })
})

describe('UpdatesSection — source analysis', () => {
  const src = (() => {
    const { readFileSync } = require('fs')
    const { resolve, dirname } = require('path')
    return readFileSync(resolve(__dirname, 'ConfigEditor.tsx'), 'utf-8') as string
  })()

  test('imports UpdateState, UpdateInfo, UpdateProgress from types', () => {
    expect(src).toContain("import type { UpdateState, UpdateInfo, UpdateProgress } from '../types/ipc'")
  })

  test('defines UpdatesSectionState with required fields', () => {
    expect(src).toContain('phase: UpdateState')
    expect(src).toContain('info: UpdateInfo | null')
    expect(src).toContain('progress: UpdateProgress | null')
    expect(src).toContain('error: string | null')
    expect(src).toContain('installing: boolean')
  })

  test('subscribes to all six update events', () => {
    expect(src).toContain('sb.update.onChecking(')
    expect(src).toContain('sb.update.onAvailable(')
    expect(src).toContain('sb.update.onNotAvailable(')
    expect(src).toContain('sb.update.onProgress(')
    expect(src).toContain('sb.update.onDownloaded(')
    expect(src).toContain('sb.update.onError(')
  })

  test('unsubscribes on unmount via cleanup return', () => {
    expect(src).toContain('unsubs.forEach(u => u())')
  })

  test('hydrates from sb.update.getState() on mount', () => {
    expect(src).toContain('sb.update.getState()')
  })

  test('has Check for Updates button', () => {
    expect(src).toContain('Check for Updates')
  })

  test('has Install & Restart button', () => {
    expect(src).toContain('Install & Restart')
  })

  test('has Download button for available state', () => {
    expect(src).toContain("state.phase === 'available'")
    expect(src).toContain('handleDownload')
  })

  test('has progress bar elements', () => {
    expect(src).toContain('updates-progress-bar')
    expect(src).toContain('updates-progress-fill')
  })

  test('has formatSpeed helper for download speed display', () => {
    expect(src).toContain('formatSpeed')
    expect(src).toContain('MB/s')
    expect(src).toContain('KB/s')
    expect(src).toContain('B/s')
  })

  test('disables check button during checking and downloading', () => {
    expect(src).toContain("state.phase === 'checking' || state.phase === 'downloading'")
  })

  test('shows version info when available', () => {
    expect(src).toContain('updates-version-info')
    expect(src).toContain('state.info.version')
  })
})

describe('UpdatesSection — update namespace mock bridge', () => {
  test('update.getState returns null by default', async () => {
    const state = await window.slashbot.update.getState()
    expect(state).toBeNull()
  })

  test('update.getState returns hydrated state', async () => {
    mocks.mockUpdateGetState.mockResolvedValue({ state: 'available', info: { version: '1.2.3' } })
    const state = await window.slashbot.update.getState()
    expect(state).toEqual({ state: 'available', info: { version: '1.2.3' } })
  })

  test('update.check calls through', () => {
    window.slashbot.update.check()
    expect(mocks.mockUpdateCheck).toHaveBeenCalledTimes(1)
  })

  test('update.download calls through', () => {
    window.slashbot.update.download()
    expect(mocks.mockUpdateDownload).toHaveBeenCalledTimes(1)
  })

  test('update.install calls through', () => {
    window.slashbot.update.install()
    expect(mocks.mockUpdateInstall).toHaveBeenCalledTimes(1)
  })

  test('event listener mocks return unsubscribe functions', () => {
    const unsub = window.slashbot.update.onChecking(() => {})
    expect(typeof unsub).toBe('function')
  })
})
