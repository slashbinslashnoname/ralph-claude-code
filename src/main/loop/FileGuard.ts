import * as fs from 'fs'
import * as path from 'path'

const REQUIRED = ['.slashbot', '.slashbot/PROMPT.md', '.slashbot/AGENT.md', '.slashbotrc']

export function validateIntegrity(projectPath: string): {
  ok: boolean
  missing: string[]
  report: string
} {
  const missing = REQUIRED.filter(p => !fs.existsSync(path.join(projectPath, p)))
  const ok = missing.length === 0
  const report = ok
    ? 'All required Slashbot files present.'
    : [
        'Missing Slashbot files:',
        ...missing.map(f => `  \u2022 ${f}`),
        '',
        'Run to restore:  slashbot-enable --force'
      ].join('\n')
  return { ok, missing, report }
}
