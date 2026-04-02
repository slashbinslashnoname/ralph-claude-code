import * as fs from 'fs'
import * as path from 'path'
import type { ProjectPaths } from './ProjectStore'
import { getProjectPaths } from './ProjectStore'

export function validateIntegrity(
  projectPath: string,
  paths?: ProjectPaths
): {
  ok: boolean
  missing: string[]
  report: string
} {
  const p = paths ?? getProjectPaths(projectPath)
  const filesToCheck = [
    { label: 'storeDir', absolute: p.storeDir },
    { label: 'PROMPT.md', absolute: path.join(p.configDir, 'PROMPT.md') },
    { label: 'AGENT.md', absolute: p.agentMd },
    { label: '.slashbotrc', absolute: path.join(p.configDir, '.slashbotrc') }
  ]

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
