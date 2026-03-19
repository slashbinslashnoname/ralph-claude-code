/**
 * RcParser — reads a .ralphrc bash-source file and extracts key=value pairs
 * without spawning a shell. Handles quoted strings and comments.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_CONFIG, RalphConfig } from './types'

const KEY_MAP: Record<string, keyof RalphConfig> = {
  MAX_CALLS_PER_HOUR:              'maxCallsPerHour',
  CLAUDE_TIMEOUT_MINUTES:          'claudeTimeoutMinutes',
  CLAUDE_OUTPUT_FORMAT:            'claudeOutputFormat',
  CLAUDE_CODE_CMD:                 'claudeCodeCmd',
  CLAUDE_ALLOWED_TOOLS:            'allowedTools',
  SLEEP_DURATION:                  'sleepDuration',
  CB_NO_PROGRESS_THRESHOLD:        'cbNoProgressThreshold',
  CB_SAME_ERROR_THRESHOLD:         'cbSameErrorThreshold',
  CB_PERMISSION_DENIAL_THRESHOLD:  'cbPermissionDenialThreshold',
  CB_COOLDOWN_MINUTES:             'cbCooldownMinutes'
}

export function parseRcFile(projectPath: string): Partial<RalphConfig> {
  const rcPath = join(projectPath, '.ralphrc')
  if (!existsSync(rcPath)) return {}

  const lines = readFileSync(rcPath, 'utf8').split('\n')
  const result: Partial<RalphConfig> = {}

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (!m) continue

    const [, key, rawVal] = m
    const mapped = KEY_MAP[key]
    if (!mapped) continue

    // Strip surrounding quotes, then inline comments
    const val = rawVal
      .replace(/^["']|["']$/g, '')
      .replace(/\s+#.*$/, '')
      .trim()

    const def = DEFAULT_CONFIG[mapped]
    if (typeof def === 'number') {
      const n = Number(val)
      if (!isNaN(n)) (result as Record<string, unknown>)[mapped] = n
    } else if (typeof def === 'boolean') {
      (result as Record<string, unknown>)[mapped] = val === 'true'
    } else {
      (result as Record<string, unknown>)[mapped] = val
    }
  }

  return result
}

export function loadConfig(projectPath: string): RalphConfig {
  return { ...DEFAULT_CONFIG, ...parseRcFile(projectPath) }
}
