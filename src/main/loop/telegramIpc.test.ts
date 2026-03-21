import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseRcFile, validateConfig } from './RcParser'

/**
 * Tests for the Telegram IPC integration.
 *
 * Since ipc.ts depends on Electron (ipcMain, dialog, BrowserWindow), we can't
 * import it directly. Instead we test the underlying logic that the handlers use:
 * - persistTelegramToRc: writing telegram config to .slashbotrc
 * - Config round-trip: write → parse → validate
 * - TelegramBot + TelegramBridge lifecycle (tested in their own test files)
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ipc-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Replicate the persistTelegramToRc logic from ipc.ts so we can test it
 * in isolation without Electron dependencies.
 */
function persistTelegramToRc(
  projectPath: string,
  botToken: string,
  chatId: string,
  enabled: boolean,
  notifyLevel: string
): void {
  const rcPath = path.join(projectPath, '.slashbotrc')
  let content = ''
  try { content = fs.readFileSync(rcPath, 'utf8') } catch { /* file may not exist */ }

  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_ENABLED', 'TELEGRAM_NOTIFY_LEVEL']
  const lines = content.split('\n').filter(line => {
    const trimmed = line.trim()
    return !keys.some(k => trimmed.startsWith(k + '='))
  })

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  lines.push(
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `TELEGRAM_CHAT_ID=${chatId}`,
    `TELEGRAM_ENABLED=${enabled}`,
    `TELEGRAM_NOTIFY_LEVEL=${notifyLevel}`,
  )

  fs.writeFileSync(rcPath, lines.join('\n') + '\n')
}

describe('persistTelegramToRc', () => {
  it('creates .slashbotrc if it does not exist', () => {
    persistTelegramToRc(tmpDir, '123456:ABCdef', '-100123', true, 'all')
    const content = fs.readFileSync(path.join(tmpDir, '.slashbotrc'), 'utf8')
    expect(content).toContain('TELEGRAM_BOT_TOKEN=123456:ABCdef')
    expect(content).toContain('TELEGRAM_CHAT_ID=-100123')
    expect(content).toContain('TELEGRAM_ENABLED=true')
    expect(content).toContain('TELEGRAM_NOTIFY_LEVEL=all')
  })

  it('preserves existing config when adding telegram settings', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), 'MAX_CALLS_PER_HOUR=200\nSLEEP_DURATION=5\n')
    persistTelegramToRc(tmpDir, '123456:ABCdef', '999', true, 'errors')
    const content = fs.readFileSync(path.join(tmpDir, '.slashbotrc'), 'utf8')
    expect(content).toContain('MAX_CALLS_PER_HOUR=200')
    expect(content).toContain('SLEEP_DURATION=5')
    expect(content).toContain('TELEGRAM_BOT_TOKEN=123456:ABCdef')
  })

  it('replaces existing telegram config without duplicating', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'),
      'TELEGRAM_BOT_TOKEN=old:token\nTELEGRAM_CHAT_ID=111\nMAX_CALLS_PER_HOUR=100\n')
    persistTelegramToRc(tmpDir, '999:NewToken', '222', true, 'completions')
    const content = fs.readFileSync(path.join(tmpDir, '.slashbotrc'), 'utf8')
    expect(content).not.toContain('old:token')
    expect(content).not.toContain('111')
    expect(content).toContain('TELEGRAM_BOT_TOKEN=999:NewToken')
    expect(content).toContain('TELEGRAM_CHAT_ID=222')
    expect(content).toContain('MAX_CALLS_PER_HOUR=100')
    // Count occurrences — should appear exactly once
    const tokenMatches = content.match(/TELEGRAM_BOT_TOKEN=/g)
    expect(tokenMatches?.length).toBe(1)
  })

  it('disconnect clears token and disables', () => {
    persistTelegramToRc(tmpDir, '123456:ABCdef', '999', true, 'all')
    // Simulate disconnect
    persistTelegramToRc(tmpDir, '', '', false, 'errors')
    const content = fs.readFileSync(path.join(tmpDir, '.slashbotrc'), 'utf8')
    expect(content).toContain('TELEGRAM_ENABLED=false')
    expect(content).toContain('TELEGRAM_BOT_TOKEN=')
  })
})

describe('Telegram config round-trip via RcParser', () => {
  it('writes and reads back telegram config correctly', () => {
    persistTelegramToRc(tmpDir, '123456:ABCdef', '-100999', true, 'completions')

    const parsed = parseRcFile(tmpDir)
    expect(parsed.telegram).toBeDefined()
    expect(parsed.telegram!.botToken).toBe('123456:ABCdef')
    expect(parsed.telegram!.chatId).toBe('-100999')
    expect(parsed.telegram!.enabled).toBe(true)
    expect(parsed.telegram!.notifyOn).toBe('completions')
  })

  it('validates the round-tripped config without warnings', () => {
    persistTelegramToRc(tmpDir, '123456:ABCdef', '-100999', true, 'errors')

    const parsed = parseRcFile(tmpDir)
    const { config, warnings } = validateConfig(parsed)
    expect(warnings).toEqual([])
    expect(config.telegram?.botToken).toBe('123456:ABCdef')
    expect(config.telegram?.chatId).toBe('-100999')
    expect(config.telegram?.enabled).toBe(true)
    expect(config.telegram?.notifyOn).toBe('errors')
  })

  it('preserves non-telegram config through round-trip', () => {
    fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), 'MAX_CALLS_PER_HOUR=300\nSLEEP_DURATION=10\n')
    persistTelegramToRc(tmpDir, '123456:ABCdef', '999', true, 'all')

    const parsed = parseRcFile(tmpDir)
    expect(parsed.maxCallsPerHour).toBe(300)
    expect(parsed.sleepDuration).toBe(10)
    expect(parsed.telegram?.botToken).toBe('123456:ABCdef')
  })
})
