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
  const bd = new BdClient(getProjectPaths(projectPath).storeDir)
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

  // 4. Check `cm` CLI availability (non-fatal)
  let cmAvailable = false
  try {
    execFileSync('which', ['cm'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
    cmAvailable = true
  } catch {
    warnings.push({
      check: 'cm',
      message: '`cm` (CASS memory) CLI not found on PATH.',
      remediation: 'Install cm for enhanced context retrieval: https://github.com/anthropics/cass',
    })
  }

  // 4b. If cm exists, check if playbook has rules
  if (cmAvailable) {
    try {
      const output = execFileSync('cm', ['playbook', 'list'], {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString()
      if (output.includes('PLAYBOOK RULES (0)') || output.includes('No active rules found')) {
        warnings.push({
          check: 'cm-playbook',
          message: 'CASS memory playbook is empty — no rules loaded.',
          remediation: "Run `cm reflect` to learn rules from sessions, or `cm playbook add \"...\"` to add rules manually.",
        })
      }
    } catch {
      // cm exists but playbook list failed — not critical, skip
    }
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
