import * as fs from 'fs'
import * as path from 'path'
import { RalphConfig, TelegramConfig, TelegramNotifyLevel } from '../types'

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: '',
  chatId: '',
  enabled: false,
  notifyOn: 'errors'
}

export const DEFAULT_CONFIG: RalphConfig = {
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
  claudeModelThink: 'sonnet',
  claudeModelExecute: 'opus',
  claudeModelReview: 'sonnet',
  telegram: { ...DEFAULT_TELEGRAM_CONFIG }
}

const KEY_MAP: Record<string, keyof RalphConfig> = {
  MAX_CALLS_PER_HOUR: 'maxCallsPerHour',
  CLAUDE_TIMEOUT_MINUTES: 'claudeTimeoutMinutes',
  CLAUDE_OUTPUT_FORMAT: 'claudeOutputFormat',
  CLAUDE_CODE_CMD: 'claudeCodeCmd',
  CLAUDE_ALLOWED_TOOLS: 'allowedTools',
  SLEEP_DURATION: 'sleepDuration',
  CB_NO_PROGRESS_THRESHOLD: 'cbNoProgressThreshold',
  CB_SAME_ERROR_THRESHOLD: 'cbSameErrorThreshold',
  CB_PERMISSION_DENIAL_THRESHOLD: 'cbPermissionDenialThreshold',
  CB_COOLDOWN_MINUTES: 'cbCooldownMinutes',
  AUTO_PUSH: 'autoPush',
  MAX_RETRIES: 'maxRetries',
  AUTO_SPLIT_THRESHOLD: 'autoSplitThreshold',
  BUILD_MONITOR_CMD: 'buildMonitorCmd',
  BUILD_MONITOR_INTERVAL: 'buildMonitorInterval',
  CLAUDE_MODEL_THINK: 'claudeModelThink',
  CLAUDE_MODEL_EXECUTE: 'claudeModelExecute',
  CLAUDE_MODEL_REVIEW: 'claudeModelReview'
}

const TELEGRAM_KEY_MAP: Record<string, keyof TelegramConfig> = {
  TELEGRAM_BOT_TOKEN: 'botToken',
  TELEGRAM_CHAT_ID: 'chatId',
  TELEGRAM_ENABLED: 'enabled',
  TELEGRAM_NOTIFY_LEVEL: 'notifyOn'
}

const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/
const VALID_NOTIFY_LEVELS = new Set<TelegramNotifyLevel>(['all', 'errors', 'completions', 'none'])

export function parseRcFile(projectPath: string, rcPath?: string): Partial<RalphConfig> {
  const resolvedPath = rcPath ?? path.join(projectPath, '.slashbotrc')
  if (!fs.existsSync(resolvedPath)) return {}
  const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n')
  const result: Record<string, unknown> = {}

  const telegram: Partial<TelegramConfig> = {}

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    const val = rawVal.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim()

    // Check Telegram keys first
    const tgMapped = TELEGRAM_KEY_MAP[key]
    if (tgMapped) {
      if (tgMapped === 'enabled') {
        telegram.enabled = val === 'true'
      } else if (tgMapped === 'notifyOn') {
        telegram.notifyOn = val as TelegramNotifyLevel
      } else {
        telegram[tgMapped] = val
      }
      continue
    }

    const mapped = KEY_MAP[key]
    if (!mapped) continue
    const def = DEFAULT_CONFIG[mapped]
    if (typeof def === 'number') {
      const n = Number(val)
      if (!isNaN(n)) result[mapped] = n
    } else if (typeof def === 'boolean') {
      result[mapped] = val === 'true'
    } else {
      result[mapped] = val
    }
  }

  if (Object.keys(telegram).length > 0) {
    result.telegram = { ...DEFAULT_TELEGRAM_CONFIG, ...telegram }
  }

  return result as Partial<RalphConfig>
}

export interface ValidationResult {
  config: RalphConfig
  warnings: string[]
}

const VALID_OUTPUT_FORMATS = new Set(['json', 'text'])

interface NumericRule {
  min: number
  max: number
}

const NUMERIC_RANGES: Partial<Record<keyof RalphConfig, NumericRule>> = {
  maxCallsPerHour: { min: 1, max: 10000 },
  claudeTimeoutMinutes: { min: 1, max: 1440 },
  sleepDuration: { min: 0, max: 3600 },
  cbNoProgressThreshold: { min: 1, max: 1000 },
  cbSameErrorThreshold: { min: 1, max: 1000 },
  cbPermissionDenialThreshold: { min: 1, max: 1000 },
  cbCooldownMinutes: { min: 1, max: 1440 },
  maxRetries: { min: 0, max: 10 },
  autoSplitThreshold: { min: 1, max: 100 },
  buildMonitorInterval: { min: 30, max: 86400 }
}

export function validateConfig(parsed: Partial<RalphConfig>): ValidationResult {
  const warnings: string[] = []
  const validated: Partial<RalphConfig> = {}

  for (const [key, value] of Object.entries(parsed)) {
    const k = key as keyof RalphConfig

    // Telegram is validated separately below
    if (k === 'telegram') continue

    // Validate claudeOutputFormat
    if (k === 'claudeOutputFormat') {
      if (!VALID_OUTPUT_FORMATS.has(value as string)) {
        warnings.push(
          `Invalid claudeOutputFormat "${value}" — expected "json" or "text". Using default "${DEFAULT_CONFIG.claudeOutputFormat}".`
        )
        continue
      }
    }

    // Validate model fields are non-empty
    if (k === 'claudeModelThink' || k === 'claudeModelExecute' || k === 'claudeModelReview') {
      if (typeof value === 'string' && value.trim() === '') {
        warnings.push(
          `Empty value for ${k}. Using default "${DEFAULT_CONFIG[k]}".`
        )
        continue
      }
    }

    // Validate string commands are non-empty
    if (k === 'claudeCodeCmd' || k === 'allowedTools') {
      if (typeof value === 'string' && value.trim() === '') {
        warnings.push(
          `Empty value for ${k}. Using default "${DEFAULT_CONFIG[k]}".`
        )
        continue
      }
    }

    // Validate buildMonitorInterval must be an integer
    if (k === 'buildMonitorInterval' && typeof value === 'number' && !Number.isInteger(value)) {
      warnings.push(
        `buildMonitorInterval must be an integer, got ${value}. Using default ${DEFAULT_CONFIG.buildMonitorInterval}.`
      )
      continue
    }

    // Validate numeric ranges
    const rule = NUMERIC_RANGES[k]
    if (rule && typeof value === 'number') {
      if (value < rule.min || value > rule.max) {
        warnings.push(
          `${k} value ${value} is out of range [${rule.min}, ${rule.max}]. Using default ${DEFAULT_CONFIG[k]}.`
        )
        continue
      }
    }

    validated[k] = value as never
  }

  // Validate telegram config if present
  if (parsed.telegram) {
    const tg = { ...DEFAULT_TELEGRAM_CONFIG, ...parsed.telegram }
    const validatedTg: TelegramConfig = { ...DEFAULT_TELEGRAM_CONFIG }

    if (tg.botToken && !TELEGRAM_BOT_TOKEN_RE.test(tg.botToken)) {
      warnings.push(
        `Invalid TELEGRAM_BOT_TOKEN format — expected "digits:alphanumeric". Using default.`
      )
    } else {
      validatedTg.botToken = tg.botToken
    }

    if (!VALID_NOTIFY_LEVELS.has(tg.notifyOn)) {
      warnings.push(
        `Invalid TELEGRAM_NOTIFY_LEVEL "${tg.notifyOn}" — expected one of: all, errors, completions, none. Using default "${DEFAULT_TELEGRAM_CONFIG.notifyOn}".`
      )
    } else {
      validatedTg.notifyOn = tg.notifyOn
    }

    validatedTg.chatId = tg.chatId
    validatedTg.enabled = tg.enabled

    validated.telegram = validatedTg
  }

  return {
    config: { ...DEFAULT_CONFIG, ...validated },
    warnings
  }
}

export function loadConfig(projectPath: string, rcPath?: string): RalphConfig {
  const parsed = parseRcFile(projectPath, rcPath)
  const { config, warnings } = validateConfig(parsed)
  for (const w of warnings) {
    console.warn(`[RcParser] ${w}`)
  }
  return config
}
