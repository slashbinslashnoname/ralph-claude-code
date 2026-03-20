import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseRcFile, loadConfig, DEFAULT_CONFIG } from './RcParser'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcparser-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeRc(content: string): void {
  fs.writeFileSync(path.join(tmpDir, '.ralphrc'), content, 'utf8')
}

// ── parseRcFile ──────────────────────────────────────────────────────────────

describe('parseRcFile', () => {
  it('returns empty object when .ralphrc is missing', () => {
    const result = parseRcFile(tmpDir)
    assert.deepEqual(result, {})
  })

  it('returns empty object for an empty file', () => {
    writeRc('')
    const result = parseRcFile(tmpDir)
    assert.deepEqual(result, {})
  })

  it('parses valid numeric keys', () => {
    writeRc('MAX_CALLS_PER_HOUR=200\nCLAUDE_TIMEOUT_MINUTES=30\nSLEEP_DURATION=10')
    const result = parseRcFile(tmpDir)
    assert.equal(result.maxCallsPerHour, 200)
    assert.equal(result.claudeTimeoutMinutes, 30)
    assert.equal(result.sleepDuration, 10)
  })

  it('parses valid string keys', () => {
    writeRc('CLAUDE_OUTPUT_FORMAT=text\nCLAUDE_CODE_CMD=/usr/local/bin/claude\nCLAUDE_ALLOWED_TOOLS=Edit,Read')
    const result = parseRcFile(tmpDir)
    assert.equal(result.claudeOutputFormat, 'text')
    assert.equal(result.claudeCodeCmd, '/usr/local/bin/claude')
    assert.equal(result.allowedTools, 'Edit,Read')
  })

  it('parses boolean continueSession — only "true" is truthy', () => {
    writeRc('CONTINUE_SESSION=true')
    // CONTINUE_SESSION is not in KEY_MAP, so it should be ignored
    // The parser only recognizes keys in KEY_MAP — there is no CONTINUE_SESSION mapping
    const result = parseRcFile(tmpDir)
    assert.equal(result.continueSession, undefined)
  })

  it('skips comment lines', () => {
    writeRc('# This is a comment\nMAX_CALLS_PER_HOUR=50\n# Another comment')
    const result = parseRcFile(tmpDir)
    assert.equal(result.maxCallsPerHour, 50)
    assert.equal(Object.keys(result).length, 1)
  })

  it('skips blank lines', () => {
    writeRc('\n\nMAX_CALLS_PER_HOUR=75\n\n')
    const result = parseRcFile(tmpDir)
    assert.equal(result.maxCallsPerHour, 75)
  })

  it('strips double-quoted values', () => {
    writeRc('CLAUDE_CODE_CMD="my-claude"')
    const result = parseRcFile(tmpDir)
    assert.equal(result.claudeCodeCmd, 'my-claude')
  })

  it('strips single-quoted values', () => {
    writeRc("CLAUDE_CODE_CMD='my-claude'")
    const result = parseRcFile(tmpDir)
    assert.equal(result.claudeCodeCmd, 'my-claude')
  })

  it('strips inline comments after whitespace', () => {
    writeRc('MAX_CALLS_PER_HOUR=150 # per hour limit')
    const result = parseRcFile(tmpDir)
    assert.equal(result.maxCallsPerHour, 150)
  })

  it('does not strip # without preceding whitespace (embedded hash)', () => {
    writeRc('CLAUDE_CODE_CMD=cmd#tag')
    const result = parseRcFile(tmpDir)
    assert.equal(result.claudeCodeCmd, 'cmd#tag')
  })

  it('ignores unknown keys', () => {
    writeRc('UNKNOWN_KEY=something\nMAX_CALLS_PER_HOUR=42')
    const result = parseRcFile(tmpDir)
    assert.equal(result.maxCallsPerHour, 42)
    assert.equal(Object.keys(result).length, 1)
  })

  it('ignores lowercase keys (regex requires uppercase)', () => {
    writeRc('max_calls_per_hour=99')
    const result = parseRcFile(tmpDir)
    assert.deepEqual(result, {})
  })

  it('ignores malformed lines without =', () => {
    writeRc('MAX_CALLS_PER_HOUR 200\nSLEEP_DURATION=5')
    const result = parseRcFile(tmpDir)
    assert.equal(result.sleepDuration, 5)
    assert.equal(Object.keys(result).length, 1)
  })

  it('ignores NaN numeric values', () => {
    writeRc('MAX_CALLS_PER_HOUR=abc')
    const result = parseRcFile(tmpDir)
    assert.equal(result.maxCallsPerHour, undefined)
  })

  it('parses all circuit breaker keys', () => {
    writeRc(
      'CB_NO_PROGRESS_THRESHOLD=10\nCB_SAME_ERROR_THRESHOLD=8\nCB_PERMISSION_DENIAL_THRESHOLD=4\nCB_COOLDOWN_MINUTES=60'
    )
    const result = parseRcFile(tmpDir)
    assert.equal(result.cbNoProgressThreshold, 10)
    assert.equal(result.cbSameErrorThreshold, 8)
    assert.equal(result.cbPermissionDenialThreshold, 4)
    assert.equal(result.cbCooldownMinutes, 60)
  })
})

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns defaults when .ralphrc is missing', () => {
    const config = loadConfig(tmpDir)
    assert.deepEqual(config, DEFAULT_CONFIG)
  })

  it('overrides defaults with parsed values', () => {
    writeRc('MAX_CALLS_PER_HOUR=500\nCLAUDE_CODE_CMD=custom-claude')
    const config = loadConfig(tmpDir)
    assert.equal(config.maxCallsPerHour, 500)
    assert.equal(config.claudeCodeCmd, 'custom-claude')
    // non-overridden fields keep defaults
    assert.equal(config.claudeTimeoutMinutes, DEFAULT_CONFIG.claudeTimeoutMinutes)
    assert.equal(config.continueSession, DEFAULT_CONFIG.continueSession)
    assert.equal(config.sleepDuration, DEFAULT_CONFIG.sleepDuration)
  })

  it('returns complete RalphConfig shape even with partial overrides', () => {
    writeRc('SLEEP_DURATION=20')
    const config = loadConfig(tmpDir)
    const keys = Object.keys(DEFAULT_CONFIG)
    for (const key of keys) {
      assert.notEqual(config[key as keyof typeof config], undefined, `key ${key} should be defined`)
    }
  })
})
