import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseRcFile, loadConfig } from '../../src/main/loop/RcParser'
import { DEFAULT_CONFIG } from '../../src/main/loop/types'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('RcParser', () => {
  let dir: string

  beforeEach(() => {
    dir = join(tmpdir(), `ralph-rc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('parseRcFile', () => {
    it('returns empty object when no .ralphrc exists', () => {
      expect(parseRcFile(dir)).toEqual({})
    })

    it('parses numeric values', () => {
      writeFileSync(join(dir, '.ralphrc'), 'MAX_CALLS_PER_HOUR=50\nCLAUDE_TIMEOUT_MINUTES=20\n')
      const result = parseRcFile(dir)
      expect(result.maxCallsPerHour).toBe(50)
      expect(result.claudeTimeoutMinutes).toBe(20)
    })

    it('parses string values', () => {
      writeFileSync(join(dir, '.ralphrc'), 'CLAUDE_CODE_CMD=npx claude\n')
      const result = parseRcFile(dir)
      expect(result.claudeCodeCmd).toBe('npx claude')
    })

    it('strips quotes from values', () => {
      writeFileSync(join(dir, '.ralphrc'), 'CLAUDE_CODE_CMD="my-claude"\n')
      const result = parseRcFile(dir)
      expect(result.claudeCodeCmd).toBe('my-claude')
    })

    it('strips single quotes', () => {
      writeFileSync(join(dir, '.ralphrc'), "CLAUDE_CODE_CMD='my-claude'\n")
      const result = parseRcFile(dir)
      expect(result.claudeCodeCmd).toBe('my-claude')
    })

    it('strips inline comments', () => {
      writeFileSync(join(dir, '.ralphrc'), 'MAX_CALLS_PER_HOUR=75 # high limit\n')
      const result = parseRcFile(dir)
      expect(result.maxCallsPerHour).toBe(75)
    })

    it('ignores comment lines', () => {
      writeFileSync(join(dir, '.ralphrc'), '# This is a comment\nMAX_CALLS_PER_HOUR=50\n')
      const result = parseRcFile(dir)
      expect(result.maxCallsPerHour).toBe(50)
    })

    it('ignores blank lines', () => {
      writeFileSync(join(dir, '.ralphrc'), '\n\nMAX_CALLS_PER_HOUR=50\n\n')
      const result = parseRcFile(dir)
      expect(result.maxCallsPerHour).toBe(50)
    })

    it('ignores unknown keys', () => {
      writeFileSync(join(dir, '.ralphrc'), 'UNKNOWN_KEY=value\nMAX_CALLS_PER_HOUR=50\n')
      const result = parseRcFile(dir)
      expect(result.maxCallsPerHour).toBe(50)
      expect(Object.keys(result)).toEqual(['maxCallsPerHour'])
    })

    it('parses all circuit breaker settings', () => {
      writeFileSync(join(dir, '.ralphrc'), [
        'CB_NO_PROGRESS_THRESHOLD=5',
        'CB_SAME_ERROR_THRESHOLD=10',
        'CB_PERMISSION_DENIAL_THRESHOLD=3',
        'CB_COOLDOWN_MINUTES=60'
      ].join('\n'))
      const result = parseRcFile(dir)
      expect(result.cbNoProgressThreshold).toBe(5)
      expect(result.cbSameErrorThreshold).toBe(10)
      expect(result.cbPermissionDenialThreshold).toBe(3)
      expect(result.cbCooldownMinutes).toBe(60)
    })

    it('parses output format', () => {
      writeFileSync(join(dir, '.ralphrc'), 'CLAUDE_OUTPUT_FORMAT=text\n')
      const result = parseRcFile(dir)
      expect(result.claudeOutputFormat).toBe('text')
    })

    it('parses allowed tools with quotes', () => {
      writeFileSync(join(dir, '.ralphrc'), 'CLAUDE_ALLOWED_TOOLS="Write,Read,Edit,Bash(npm *)"\n')
      const result = parseRcFile(dir)
      expect(result.allowedTools).toBe('Write,Read,Edit,Bash(npm *)')
    })

    it('ignores invalid numeric values', () => {
      writeFileSync(join(dir, '.ralphrc'), 'MAX_CALLS_PER_HOUR=not_a_number\n')
      const result = parseRcFile(dir)
      expect(result.maxCallsPerHour).toBeUndefined()
    })
  })

  describe('loadConfig', () => {
    it('returns defaults when no .ralphrc', () => {
      const config = loadConfig(dir)
      expect(config).toEqual(DEFAULT_CONFIG)
    })

    it('merges .ralphrc values over defaults', () => {
      writeFileSync(join(dir, '.ralphrc'), 'MAX_CALLS_PER_HOUR=50\nSLEEP_DURATION=5\n')
      const config = loadConfig(dir)
      expect(config.maxCallsPerHour).toBe(50)
      expect(config.sleepDuration).toBe(5)
      // Defaults preserved for unset keys
      expect(config.claudeTimeoutMinutes).toBe(DEFAULT_CONFIG.claudeTimeoutMinutes)
      expect(config.claudeCodeCmd).toBe(DEFAULT_CONFIG.claudeCodeCmd)
    })
  })
})
