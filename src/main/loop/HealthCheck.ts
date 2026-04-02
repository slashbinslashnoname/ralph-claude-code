import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { validateIntegrity } from './FileGuard'
import { BdClient } from './BdClient'
import { getProjectPaths } from './ProjectStore'

export interface HealthCheckError {
  check: string
  message: string
  remediation: string
}

export interface HealthCheckWarning {
  check: string
  message: string
  remediation: string
}

export interface HealthCheckResult {
  ok: boolean
  errors: HealthCheckError[]
  warnings: HealthCheckWarning[]
}

/**
 * Pre-flight health check that verifies all required tools and files
 * are available before the swarm starts.
 */
export function runHealthCheck(projectPath: string, claudeCmd = 'claude'): HealthCheckResult {
  const errors: HealthCheckError[] = []
  const warnings: HealthCheckWarning[] = []

  // 1. Check `bd` CLI and .beads directory
  const bd = new BdClient(getProjectPaths(projectPath).beadsCwd)
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

  // 3. Check required Slashbot files (.slashbot/, .slashbot/PROMPT.md, .slashbot/AGENT.md, .slashbotrc)
  const integrity = validateIntegrity(projectPath)
  if (!integrity.ok) {
    errors.push({
      check: 'slashbot-files',
      message: `Missing Slashbot files: ${integrity.missing.join(', ')}`,
      remediation: 'Run `slashbot-enable --force` to restore required files.',
    })
  }

  // 4. Check `sm` (slashmem) CLI — optional but recommended
  try {
    execFileSync('which', ['sm'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    warnings.push({
      check: 'sm',
      message: '`sm` (slashmem) CLI not found on PATH. Agents will not be able to manage persistent memory.',
      remediation: 'Install slashmem: cargo install slashmem (https://github.com/anthropics/slashmem)',
    })
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** Format health check errors into a human-readable report. */
export function formatHealthErrors(errors: HealthCheckError[]): string {
  return errors.map(e =>
    `[${e.check}] ${e.message}\n  → ${e.remediation}`
  ).join('\n\n')
}

/** Format health check warnings into a human-readable report. */
export function formatHealthWarnings(warnings: HealthCheckWarning[]): string {
  return warnings.map(w =>
    `[${w.check}] ${w.message}\n  → ${w.remediation}`
  ).join('\n\n')
}
