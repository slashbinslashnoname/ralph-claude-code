import * as fs from 'fs'
import * as path from 'path'
import { RalphConfig } from '../types'

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
  autoPush: true
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
  AUTO_PUSH: 'autoPush'
}

export function parseRcFile(projectPath: string): Partial<RalphConfig> {
  const rcPath = path.join(projectPath, '.ralphrc')
  if (!fs.existsSync(rcPath)) return {}
  const lines = fs.readFileSync(rcPath, 'utf8').split('\n')
  const result: Record<string, unknown> = {}

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    const mapped = KEY_MAP[key]
    if (!mapped) continue
    const val = rawVal.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim()
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
  return result as Partial<RalphConfig>
}

export function loadConfig(projectPath: string): RalphConfig {
  return { ...DEFAULT_CONFIG, ...parseRcFile(projectPath) }
}
