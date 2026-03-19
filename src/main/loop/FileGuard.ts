import { existsSync } from 'fs'
import { join } from 'path'

const REQUIRED = [
  '.ralph',
  '.ralph/PROMPT.md',
  '.ralph/AGENT.md',
  '.ralphrc'
]

export interface IntegrityResult {
  ok: boolean
  missing: string[]
  report: string
}

export function validateIntegrity(projectPath: string): IntegrityResult {
  const missing = REQUIRED.filter(p => !existsSync(join(projectPath, p)))
  const ok = missing.length === 0

  const report = ok
    ? 'All required Ralph files present.'
    : [
        'Missing Ralph files:',
        ...missing.map(f => `  • ${f}`),
        '',
        'Run to restore:  ralph-enable --force'
      ].join('\n')

  return { ok, missing, report }
}
