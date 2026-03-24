import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'


import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseRcFile, loadConfig, validateConfig, serializeConfig, DEFAULT_CONFIG, DEFAULT_TELEGRAM_CONFIG } from './RcParser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcparser-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeRc(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.slashbotrc'), content, 'utf8')
}

// ── parseRcFile ──────────────────────────────────────────────────────────────

describe('parseRcFile', () => {
  it('returns empty object when .slashbotrc is missing', () => {
    const result = parseRcFile(tmpDir)
    expect(result).toEqual({})
  })

  it('returns empty object for an empty file', () => {
    writeRc('')
    const result = parseRcFile(tmpDir)
    expect(result).toEqual({})
  })

  it('parses valid numeric keys', () => {
    writeRc('MAX_CALLS_PER_HOUR=200\nCLAUDE_TIMEOUT_MINUTES=30\nSLEEP_DURATION=10')
    const result = parseRcFile(tmpDir)
    expect(result.maxCallsPerHour).toBe(200)
    expect(result.claudeTimeoutMinutes).toBe(30)
    expect(result.sleepDuration).toBe(10)
  })

  it('parses valid string keys', () => {
    writeRc('CLAUDE_OUTPUT_FORMAT=text\nCLAUDE_CODE_CMD=/usr/local/bin/claude\nCLAUDE_ALLOWED_TOOLS=Edit,Read')
    const result = parseRcFile(tmpDir)
    expect(result.claudeOutputFormat).toBe('text')
    expect(result.claudeCodeCmd).toBe('/usr/local/bin/claude')
    expect(result.allowedTools).toBe('Edit,Read')
  })

  it('parses boolean continueSession — only "true" is truthy', () => {
    writeRc('CONTINUE_SESSION=true')
    const result = parseRcFile(tmpDir)
    expect(result.continueSession).toBe(true)
  })

  it('parses CONTINUE_SESSION=false as boolean false', () => {
    writeRc('CONTINUE_SESSION=false')
    const result = parseRcFile(tmpDir)
    expect(result.continueSession).toBe(false)
  })

  it('skips comment lines', () => {
    writeRc('# This is a comment\nMAX_CALLS_PER_HOUR=50\n# Another comment')
    const result = parseRcFile(tmpDir)
    expect(result.maxCallsPerHour).toBe(50)
    expect(Object.keys(result).length).toBe(1)
  })

  it('skips blank lines', () => {
    writeRc('\n\nMAX_CALLS_PER_HOUR=75\n\n')
    const result = parseRcFile(tmpDir)
    expect(result.maxCallsPerHour).toBe(75)
  })

  it('strips double-quoted values', () => {
    writeRc('CLAUDE_CODE_CMD="my-claude"')
    const result = parseRcFile(tmpDir)
    expect(result.claudeCodeCmd).toBe('my-claude')
  })

  it('strips single-quoted values', () => {
    writeRc("CLAUDE_CODE_CMD='my-claude'")
    const result = parseRcFile(tmpDir)
    expect(result.claudeCodeCmd).toBe('my-claude')
  })

  it('strips inline comments after whitespace', () => {
    writeRc('MAX_CALLS_PER_HOUR=150 # per hour limit')
    const result = parseRcFile(tmpDir)
    expect(result.maxCallsPerHour).toBe(150)
  })

  it('does not strip # without preceding whitespace (embedded hash)', () => {
    writeRc('CLAUDE_CODE_CMD=cmd#tag')
    const result = parseRcFile(tmpDir)
    expect(result.claudeCodeCmd).toBe('cmd#tag')
  })

  it('ignores unknown keys', () => {
    writeRc('UNKNOWN_KEY=something\nMAX_CALLS_PER_HOUR=42')
    const result = parseRcFile(tmpDir)
    expect(result.maxCallsPerHour).toBe(42)
    expect(Object.keys(result).length).toBe(1)
  })

  it('ignores lowercase keys (regex requires uppercase)', () => {
    writeRc('max_calls_per_hour=99')
    const result = parseRcFile(tmpDir)
    expect(result).toEqual({})
  })

  it('ignores malformed lines without =', () => {
    writeRc('MAX_CALLS_PER_HOUR 200\nSLEEP_DURATION=5')
    const result = parseRcFile(tmpDir)
    expect(result.sleepDuration).toBe(5)
    expect(Object.keys(result).length).toBe(1)
  })

  it('ignores NaN numeric values', () => {
    writeRc('MAX_CALLS_PER_HOUR=abc')
    const result = parseRcFile(tmpDir)
    expect(result.maxCallsPerHour).toBe(undefined)
  })

  it('parses all circuit breaker keys', () => {
    writeRc(
      'CB_NO_PROGRESS_THRESHOLD=10\nCB_SAME_ERROR_THRESHOLD=8\nCB_PERMISSION_DENIAL_THRESHOLD=4\nCB_COOLDOWN_MINUTES=60'
    )
    const result = parseRcFile(tmpDir)
    expect(result.cbNoProgressThreshold).toBe(10)
    expect(result.cbSameErrorThreshold).toBe(8)
    expect(result.cbPermissionDenialThreshold).toBe(4)
    expect(result.cbCooldownMinutes).toBe(60)
  })

  it('reads from explicit rcPath when provided', () => {
    const customPath = path.join(tmpDir, 'custom.rc')
    fs.writeFileSync(customPath, 'MAX_CALLS_PER_HOUR=999', 'utf8')
    const result = parseRcFile(tmpDir, customPath)
    expect(result.maxCallsPerHour).toBe(999)
  })

  it('ignores .slashbotrc in projectPath when rcPath is provided', () => {
    writeRc('MAX_CALLS_PER_HOUR=111')
    const customPath = path.join(tmpDir, 'other.rc')
    fs.writeFileSync(customPath, 'MAX_CALLS_PER_HOUR=222', 'utf8')
    const result = parseRcFile(tmpDir, customPath)
    expect(result.maxCallsPerHour).toBe(222)
  })

  it('returns empty object when explicit rcPath does not exist', () => {
    const result = parseRcFile(tmpDir, path.join(tmpDir, 'nonexistent.rc'))
    expect(result).toEqual({})
  })

  it('parses AUTO_SPLIT_THRESHOLD', () => {
    writeRc('AUTO_SPLIT_THRESHOLD=5')
    const result = parseRcFile(tmpDir)
    expect(result.autoSplitThreshold).toBe(5)
  })

  it('parses BUILD_MONITOR_CMD', () => {
    writeRc('BUILD_MONITOR_CMD=npm run build:check')
    const result = parseRcFile(tmpDir)
    expect(result.buildMonitorCmd).toBe('npm run build:check')
  })

  it('parses BUILD_MONITOR_INTERVAL', () => {
    writeRc('BUILD_MONITOR_INTERVAL=60')
    const result = parseRcFile(tmpDir)
    expect(result.buildMonitorInterval).toBe(60)
  })
})

// ── validateConfig ──────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('passes through valid values unchanged', () => {
    const parsed = { maxCallsPerHour: 200, claudeOutputFormat: 'text' as const, sleepDuration: 10 }
    const { config, warnings } = validateConfig(parsed)
    expect(warnings).toEqual([])
    expect(config.maxCallsPerHour).toBe(200)
    expect(config.claudeOutputFormat).toBe('text')
    expect(config.sleepDuration).toBe(10)
  })

  it('rejects invalid claudeOutputFormat and falls back to default', () => {
    const { config, warnings } = validateConfig({ claudeOutputFormat: 'xml' as never })
    expect(config.claudeOutputFormat).toBe(DEFAULT_CONFIG.claudeOutputFormat)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid claudeOutputFormat')
    expect(warnings[0]).toContain('xml')
  })

  it('rejects empty claudeCodeCmd', () => {
    const { config, warnings } = validateConfig({ claudeCodeCmd: '' })
    expect(config.claudeCodeCmd).toBe(DEFAULT_CONFIG.claudeCodeCmd)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Empty value for claudeCodeCmd')
  })

  it('rejects empty allowedTools', () => {
    const { config, warnings } = validateConfig({ allowedTools: '   ' })
    expect(config.allowedTools).toBe(DEFAULT_CONFIG.allowedTools)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Empty value for allowedTools')
  })

  it('rejects maxCallsPerHour below minimum', () => {
    const { config, warnings } = validateConfig({ maxCallsPerHour: 0 })
    expect(config.maxCallsPerHour).toBe(DEFAULT_CONFIG.maxCallsPerHour)
    expect(warnings[0]).toContain('out of range')
  })

  it('rejects maxCallsPerHour above maximum', () => {
    const { config, warnings } = validateConfig({ maxCallsPerHour: 99999 })
    expect(config.maxCallsPerHour).toBe(DEFAULT_CONFIG.maxCallsPerHour)
    expect(warnings[0]).toContain('out of range')
  })

  it('rejects claudeTimeoutMinutes below minimum', () => {
    const { config, warnings } = validateConfig({ claudeTimeoutMinutes: 0 })
    expect(config.claudeTimeoutMinutes).toBe(DEFAULT_CONFIG.claudeTimeoutMinutes)
    expect(warnings[0]).toContain('out of range')
  })

  it('rejects negative sleepDuration', () => {
    const { config, warnings } = validateConfig({ sleepDuration: -1 })
    expect(config.sleepDuration).toBe(DEFAULT_CONFIG.sleepDuration)
    expect(warnings[0]).toContain('out of range')
  })

  it('accepts sleepDuration of 0 (minimum)', () => {
    const { config, warnings } = validateConfig({ sleepDuration: 0 })
    expect(config.sleepDuration).toBe(0)
    expect(warnings).toEqual([])
  })

  it('rejects circuit breaker thresholds below 1', () => {
    const { config, warnings } = validateConfig({
      cbNoProgressThreshold: 0,
      cbSameErrorThreshold: 0,
      cbPermissionDenialThreshold: 0,
      cbCooldownMinutes: 0
    })
    expect(warnings.length).toBe(4)
    expect(config.cbNoProgressThreshold).toBe(DEFAULT_CONFIG.cbNoProgressThreshold)
    expect(config.cbSameErrorThreshold).toBe(DEFAULT_CONFIG.cbSameErrorThreshold)
    expect(config.cbPermissionDenialThreshold).toBe(DEFAULT_CONFIG.cbPermissionDenialThreshold)
    expect(config.cbCooldownMinutes).toBe(DEFAULT_CONFIG.cbCooldownMinutes)
  })

  it('collects multiple warnings', () => {
    const { warnings } = validateConfig({
      maxCallsPerHour: -5,
      claudeOutputFormat: 'yaml' as never,
      claudeCodeCmd: ''
    })
    expect(warnings.length).toBe(3)
  })

  it('booleans pass through without validation', () => {
    const { config, warnings } = validateConfig({ autoPush: false, continueSession: false })
    expect(warnings).toEqual([])
    expect(config.autoPush).toBe(false)
    expect(config.continueSession).toBe(false)
  })

  it('returns full config shape with defaults for omitted keys', () => {
    const { config } = validateConfig({})
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('rejects buildMonitorInterval below minimum (30)', () => {
    const { config, warnings } = validateConfig({ buildMonitorInterval: 29 })
    expect(config.buildMonitorInterval).toBe(DEFAULT_CONFIG.buildMonitorInterval)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('out of range')
  })

  it('rejects non-integer buildMonitorInterval', () => {
    const { config, warnings } = validateConfig({ buildMonitorInterval: 45.5 })
    expect(config.buildMonitorInterval).toBe(DEFAULT_CONFIG.buildMonitorInterval)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('must be an integer')
  })

  it('accepts valid buildMonitorInterval', () => {
    const { config, warnings } = validateConfig({ buildMonitorInterval: 60 })
    expect(config.buildMonitorInterval).toBe(60)
    expect(warnings).toEqual([])
  })

  it('DEFAULT_CONFIG includes buildMonitor fields with correct defaults', () => {
    expect(DEFAULT_CONFIG.buildMonitorCmd).toBe('')
    expect(DEFAULT_CONFIG.buildMonitorInterval).toBe(120)
  })

  it('rejects empty claudeModelThink and falls back to default', () => {
    const { config, warnings } = validateConfig({ claudeModelThink: '' })
    expect(config.claudeModelThink).toBe('sonnet')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Empty value for claudeModelThink')
  })

  it('rejects empty claudeModelExecute and falls back to default', () => {
    const { config, warnings } = validateConfig({ claudeModelExecute: '' })
    expect(config.claudeModelExecute).toBe('opus')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Empty value for claudeModelExecute')
  })

  it('rejects empty claudeModelReview and falls back to default', () => {
    const { config, warnings } = validateConfig({ claudeModelReview: '' })
    expect(config.claudeModelReview).toBe('sonnet')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Empty value for claudeModelReview')
  })

  it('accepts valid non-empty model strings without warning', () => {
    const { config, warnings } = validateConfig({
      claudeModelThink: 'opus',
      claudeModelExecute: 'haiku',
      claudeModelReview: 'opus'
    })
    expect(warnings).toEqual([])
    expect(config.claudeModelThink).toBe('opus')
    expect(config.claudeModelExecute).toBe('haiku')
    expect(config.claudeModelReview).toBe('opus')
  })

  it('DEFAULT_CONFIG includes model fields with correct defaults', () => {
    expect(DEFAULT_CONFIG.claudeModelThink).toBe('sonnet')
    expect(DEFAULT_CONFIG.claudeModelExecute).toBe('opus')
    expect(DEFAULT_CONFIG.claudeModelReview).toBe('sonnet')
  })
})

// ── telegram config ──────────────────────────────────────────────────────────

describe('telegram config parsing', () => {
  it('parses all 4 Telegram keys from .slashbotrc', () => {
    writeRc(
      'TELEGRAM_BOT_TOKEN=123456:ABC-def_GHI\nTELEGRAM_CHAT_ID=-100123\nTELEGRAM_ENABLED=true\nTELEGRAM_NOTIFY_LEVEL=all'
    )
    const result = parseRcFile(tmpDir)
    expect(result.telegram).toEqual({
      botToken: '123456:ABC-def_GHI',
      chatId: '-100123',
      enabled: true,
      notifyOn: 'all'
    })
  })

  it('defaults telegram fields when no Telegram keys in rc file', () => {
    writeRc('MAX_CALLS_PER_HOUR=50')
    const result = parseRcFile(tmpDir)
    expect(result.telegram).toBeUndefined()
    // loadConfig should still have telegram defaults
    const config = loadConfig(tmpDir)
    expect(config.telegram).toEqual(DEFAULT_TELEGRAM_CONFIG)
  })

  it('merges partial Telegram config with defaults', () => {
    writeRc('TELEGRAM_BOT_TOKEN=123456:ABCdef')
    const result = parseRcFile(tmpDir)
    expect(result.telegram).toEqual({
      ...DEFAULT_TELEGRAM_CONFIG,
      botToken: '123456:ABCdef'
    })
  })

  it('TELEGRAM_ENABLED=false parses as boolean false', () => {
    writeRc('TELEGRAM_ENABLED=false')
    const result = parseRcFile(tmpDir)
    expect(result.telegram!.enabled).toBe(false)
  })

  it('TELEGRAM_ENABLED only treats literal "true" as truthy', () => {
    for (const val of ['TRUE', 'True', '1', 'yes', 'on', '']) {
      writeRc(`TELEGRAM_ENABLED=${val}`)
      const result = parseRcFile(tmpDir)
      expect(result.telegram!.enabled).toBe(false)
    }
  })

  it('parses each Telegram key individually', () => {
    writeRc('TELEGRAM_CHAT_ID=-999')
    expect(parseRcFile(tmpDir).telegram).toEqual({
      ...DEFAULT_TELEGRAM_CONFIG,
      chatId: '-999'
    })
  })

  it('parses TELEGRAM_NOTIFY_LEVEL individually', () => {
    writeRc('TELEGRAM_NOTIFY_LEVEL=completions')
    expect(parseRcFile(tmpDir).telegram).toEqual({
      ...DEFAULT_TELEGRAM_CONFIG,
      notifyOn: 'completions'
    })
  })

  it('parses TELEGRAM_ENABLED=true individually', () => {
    writeRc('TELEGRAM_ENABLED=true')
    expect(parseRcFile(tmpDir).telegram).toEqual({
      ...DEFAULT_TELEGRAM_CONFIG,
      enabled: true
    })
  })
})

describe('telegram config validation', () => {
  it('valid bot token passes validation', () => {
    const { config, warnings } = validateConfig({
      telegram: { botToken: '123456789:ABCdefGHI_jkl-mno', chatId: '-100', enabled: true, notifyOn: 'all' }
    })
    expect(warnings).toEqual([])
    expect(config.telegram!.botToken).toBe('123456789:ABCdefGHI_jkl-mno')
  })

  it('invalid bot token (no colon) produces warning and falls back to default', () => {
    const { config, warnings } = validateConfig({
      telegram: { botToken: 'invalidtoken', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_BOT_TOKEN format')
    expect(config.telegram!.botToken).toBe(DEFAULT_TELEGRAM_CONFIG.botToken)
  })

  it('invalid bot token (special chars) produces warning', () => {
    const { config, warnings } = validateConfig({
      telegram: { botToken: '123:abc!@#', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_BOT_TOKEN format')
    expect(config.telegram!.botToken).toBe(DEFAULT_TELEGRAM_CONFIG.botToken)
  })

  it('empty bot token passes validation (not required)', () => {
    const { warnings } = validateConfig({
      telegram: { botToken: '', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings).toEqual([])
  })

  it('valid notifyOn values pass validation', () => {
    for (const level of ['all', 'errors', 'completions', 'none'] as const) {
      const { warnings } = validateConfig({
        telegram: { botToken: '', chatId: '', enabled: false, notifyOn: level }
      })
      expect(warnings).toEqual([])
    }
  })

  it('invalid notifyOn falls back to default with warning', () => {
    const { config, warnings } = validateConfig({
      telegram: { botToken: '', chatId: '', enabled: false, notifyOn: 'important' as never }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_NOTIFY_LEVEL')
    expect(warnings[0]).toContain('important')
    expect(config.telegram!.notifyOn).toBe(DEFAULT_TELEGRAM_CONFIG.notifyOn)
  })

  it('rejects bot token starting with colon', () => {
    const { warnings } = validateConfig({
      telegram: { botToken: ':ABCdef', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_BOT_TOKEN format')
  })

  it('rejects bot token with letters before colon', () => {
    const { warnings } = validateConfig({
      telegram: { botToken: 'abc:def', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_BOT_TOKEN format')
  })

  it('rejects bot token containing spaces', () => {
    const { warnings } = validateConfig({
      telegram: { botToken: '123: abc def', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_BOT_TOKEN format')
  })

  it('rejects bot token that is just a colon', () => {
    const { warnings } = validateConfig({
      telegram: { botToken: ':', chatId: '', enabled: false, notifyOn: 'errors' }
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('Invalid TELEGRAM_BOT_TOKEN format')
  })
})

describe('DEFAULT_TELEGRAM_CONFIG', () => {
  it('has enabled === false', () => {
    expect(DEFAULT_TELEGRAM_CONFIG.enabled).toBe(false)
  })

  it('has notifyOn === "errors"', () => {
    expect(DEFAULT_TELEGRAM_CONFIG.notifyOn).toBe('errors')
  })

  it('has empty botToken and chatId', () => {
    expect(DEFAULT_TELEGRAM_CONFIG.botToken).toBe('')
    expect(DEFAULT_TELEGRAM_CONFIG.chatId).toBe('')
  })
})

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns defaults when .slashbotrc is missing', () => {
    const config = loadConfig(tmpDir)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('overrides defaults with parsed values', () => {
    writeRc('MAX_CALLS_PER_HOUR=500\nCLAUDE_CODE_CMD=custom-claude')
    const config = loadConfig(tmpDir)
    expect(config.maxCallsPerHour).toBe(500)
    expect(config.claudeCodeCmd).toBe('custom-claude')
    // non-overridden fields keep defaults
    expect(config.claudeTimeoutMinutes).toBe(DEFAULT_CONFIG.claudeTimeoutMinutes)
    expect(config.continueSession).toBe(DEFAULT_CONFIG.continueSession)
    expect(config.sleepDuration).toBe(DEFAULT_CONFIG.sleepDuration)
  })

  it('returns complete RalphConfig shape even with partial overrides', () => {
    writeRc('SLEEP_DURATION=20')
    const config = loadConfig(tmpDir)
    const keys = Object.keys(DEFAULT_CONFIG)
    for (const key of keys) {
      expect(config[key as keyof typeof config]).not.toBe(undefined)
    }
  })

  it('parses per-phase model overrides from rc file', () => {
    writeRc(
      'CLAUDE_MODEL_THINK=opus\nCLAUDE_MODEL_EXECUTE=sonnet\nCLAUDE_MODEL_REVIEW=haiku'
    )
    const config = loadConfig(tmpDir)
    expect(config.claudeModelThink).toBe('opus')
    expect(config.claudeModelExecute).toBe('sonnet')
    expect(config.claudeModelReview).toBe('haiku')
  })

  it('defaults per-phase model fields to sonnet/opus/sonnet', () => {
    writeRc('')
    const config = loadConfig(tmpDir)
    expect(config.claudeModelThink).toBe('sonnet')
    expect(config.claudeModelExecute).toBe('opus')
    expect(config.claudeModelReview).toBe('sonnet')
  })

  it('loads config from explicit rcPath when provided', () => {
    const customPath = path.join(tmpDir, 'custom.rc')
    fs.writeFileSync(customPath, 'MAX_CALLS_PER_HOUR=300\nCLAUDE_CODE_CMD=my-claude', 'utf8')
    const config = loadConfig(tmpDir, customPath)
    expect(config.maxCallsPerHour).toBe(300)
    expect(config.claudeCodeCmd).toBe('my-claude')
    expect(config.claudeTimeoutMinutes).toBe(DEFAULT_CONFIG.claudeTimeoutMinutes)
  })

  it('falls back to defaults for invalid values in .slashbotrc', () => {
    writeRc(
      'MAX_CALLS_PER_HOUR=0\nCLAUDE_OUTPUT_FORMAT=yaml\nCLAUDE_TIMEOUT_MINUTES=5\nSLEEP_DURATION=-1'
    )
    const config = loadConfig(tmpDir)
    // Invalid values get replaced with defaults
    expect(config.maxCallsPerHour).toBe(DEFAULT_CONFIG.maxCallsPerHour)
    expect(config.claudeOutputFormat).toBe(DEFAULT_CONFIG.claudeOutputFormat)
    expect(config.sleepDuration).toBe(DEFAULT_CONFIG.sleepDuration)
    // Valid value passes through
    expect(config.claudeTimeoutMinutes).toBe(5)
  })
})

// ── serializeConfig ─────────────────────────────────────────────────────────

describe('serializeConfig', () => {
  it('round-trips: serializeConfig(loadConfig()) produces parseable output', () => {
    writeRc('MAX_CALLS_PER_HOUR=200\nCLAUDE_TIMEOUT_MINUTES=30\nSLEEP_DURATION=10\nCONTINUE_SESSION=false')
    const config = loadConfig(tmpDir)
    const serialized = serializeConfig(config)

    // Write serialized output and re-parse
    const roundTripPath = path.join(tmpDir, '.slashbotrc-roundtrip')
    fs.writeFileSync(roundTripPath, serialized, 'utf8')
    const reloaded = loadConfig(tmpDir, roundTripPath)

    expect(reloaded).toEqual(config)
  })

  it('round-trips DEFAULT_CONFIG without loss', () => {
    const serialized = serializeConfig(DEFAULT_CONFIG)
    const roundTripPath = path.join(tmpDir, '.slashbotrc-rt')
    fs.writeFileSync(roundTripPath, serialized, 'utf8')
    const reloaded = loadConfig(tmpDir, roundTripPath)

    expect(reloaded).toEqual(DEFAULT_CONFIG)
  })

  it('emits comment headers per group', () => {
    const serialized = serializeConfig(DEFAULT_CONFIG)
    expect(serialized).toContain('# Rate limiting')
    expect(serialized).toContain('# Timeouts')
    expect(serialized).toContain('# Session')
    expect(serialized).toContain('# Claude settings')
    expect(serialized).toContain('# Circuit breaker')
    expect(serialized).toContain('# Retries & splitting')
    expect(serialized).toContain('# Build monitor')
    expect(serialized).toContain('# Model overrides')
  })

  it('includes CONTINUE_SESSION key', () => {
    const serialized = serializeConfig(DEFAULT_CONFIG)
    expect(serialized).toContain('CONTINUE_SESSION=true')
  })

  it('omits telegram section when botToken is empty', () => {
    const serialized = serializeConfig(DEFAULT_CONFIG)
    expect(serialized).not.toContain('# Telegram')
    expect(serialized).not.toContain('TELEGRAM_BOT_TOKEN')
  })

  it('includes telegram section when botToken is non-empty', () => {
    const config = {
      ...DEFAULT_CONFIG,
      telegram: {
        botToken: '123456:ABCdef',
        chatId: '-100',
        enabled: true,
        notifyOn: 'all' as const
      }
    }
    const serialized = serializeConfig(config)
    expect(serialized).toContain('# Telegram')
    expect(serialized).toContain('TELEGRAM_BOT_TOKEN=123456:ABCdef')
    expect(serialized).toContain('TELEGRAM_CHAT_ID=-100')
    expect(serialized).toContain('TELEGRAM_ENABLED=true')
    expect(serialized).toContain('TELEGRAM_NOTIFY_LEVEL=all')
  })

  it('round-trips telegram fields correctly', () => {
    const config = {
      ...DEFAULT_CONFIG,
      telegram: {
        botToken: '999:XYZ_abc',
        chatId: '-200',
        enabled: false,
        notifyOn: 'completions' as const
      }
    }
    const serialized = serializeConfig(config)
    const roundTripPath = path.join(tmpDir, '.slashbotrc-tg')
    fs.writeFileSync(roundTripPath, serialized, 'utf8')
    const reloaded = loadConfig(tmpDir, roundTripPath)

    expect(reloaded.telegram).toEqual(config.telegram)
  })

  it('preserves numeric bounds at edges', () => {
    const config = {
      ...DEFAULT_CONFIG,
      maxCallsPerHour: 1,
      sleepDuration: 0,
      maxRetries: 10,
      buildMonitorInterval: 30
    }
    const serialized = serializeConfig(config)
    const roundTripPath = path.join(tmpDir, '.slashbotrc-bounds')
    fs.writeFileSync(roundTripPath, serialized, 'utf8')
    const reloaded = loadConfig(tmpDir, roundTripPath)

    expect(reloaded.maxCallsPerHour).toBe(1)
    expect(reloaded.sleepDuration).toBe(0)
    expect(reloaded.maxRetries).toBe(10)
    expect(reloaded.buildMonitorInterval).toBe(30)
  })

  it('ends with a trailing newline', () => {
    const serialized = serializeConfig(DEFAULT_CONFIG)
    expect(serialized.endsWith('\n')).toBe(true)
  })
})
