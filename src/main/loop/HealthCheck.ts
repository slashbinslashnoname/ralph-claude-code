import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { validateIntegrity } from './FileGuard'
import { BdClient } from './BdClient'

export interface HealthCheckError {
  check: string
  message: string
  remediation: string
}

export interface HealthCheckResult {
  ok: boolean
  errors: HealthCheckError[]
}

/**
 * Pre-flight health check that verifies all required tools and files
 * are available before the swarm starts.
 */
export function runHealthCheck(projectPath: string, claudeCmd = 'claude'): HealthCheckResult {
  const errors: HealthCheckError[] = []

  // 1. Check `bd` CLI and .beads directory
  const bd = new BdClient(projectPath)
  const bdCheck = bd.check()
  if (!bdCheck.available) {
    const isMissingBinary = bdCheck.reason?.includes('not found')
    errors.push({
      check: 'bd',
      message: bdCheck.reason ?? '`bd` is not available',
      remediation: isMissingBinary
        ? 'Install beads-rust: cargo install beads-rust (https://github.com/steveyegge/beads)'
        : 'Run `bd init` in the project directory to initialize beads.',
    })
  }

  // 2. Check Claude CLI
  try {
    if (claudeCmd.startsWith('/')) {
      if (!fs.existsSync(claudeCmd)) {
        throw new Error('not found')
      }
    } else {
      execFileSync('which', [claudeCmd], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
    }
  } catch {
    errors.push({
      check: 'claude',
      message: `\`${claudeCmd}\` command not found on PATH.`,
      remediation: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    })
  }

  // 3. Check required Ralph files (.ralph/, .ralph/PROMPT.md, .ralph/AGENT.md, .ralphrc)
  const integrity = validateIntegrity(projectPath)
  if (!integrity.ok) {
    errors.push({
      check: 'ralph-files',
      message: `Missing Ralph files: ${integrity.missing.join(', ')}`,
      remediation: 'Run `ralph-enable --force` to restore required files.',
    })
  }

  return { ok: errors.length === 0, errors }
}

/** Format health check errors into a human-readable report. */
export function formatHealthErrors(errors: HealthCheckError[]): string {
  return errors.map(e =>
    `[${e.check}] ${e.message}\n  → ${e.remediation}`
  ).join('\n\n')
}
