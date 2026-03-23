import * as fs from 'fs'
import * as path from 'path'
import type { ProjectPaths } from './ProjectStore'

const REQUIRED = ['.slashbot', '.slashbot/PROMPT.md', '.slashbot/AGENT.md', '.slashbotrc']

export function validateIntegrity(
  projectPath: string,
  paths?: ProjectPaths
): {
  ok: boolean
  missing: string[]
  report: string
} {
  const filesToCheck: { label: string; absolute: string }[] = paths
    ? [
        { label: 'storeDir', absolute: paths.storeDir },
        { label: 'PROMPT.md', absolute: path.join(paths.configDir, 'PROMPT.md') },
        { label: 'AGENT.md', absolute: paths.agentMd },
        { label: '.slashbotrc', absolute: path.join(paths.configDir, '.slashbotrc') }
      ]
    : REQUIRED.map(p => ({ label: p, absolute: path.join(projectPath, p) }))

  const missing = filesToCheck.filter(f => !fs.existsSync(f.absolute)).map(f => f.label)
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
