import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export interface ProjectPaths {
  /** Human-readable project ID: <basename>-<8-char-sha256-prefix> */
  id: string
  /** Absolute path to the project root */
  projectRoot: string
  /** ~/.slashbot/projects/<id> */
  storeDir: string
  /** ~/.slashbot/projects/<id>/logs */
  logsDir: string
  /** ~/.slashbot/projects/<id>/.circuit_breaker_state */
  circuitBreakerState: string
  /** ~/.slashbot/projects/<id>/.call_count */
  callCount: string
  /** ~/.slashbot/projects/<id>/activity.jsonl */
  activity: string
  /** ~/.slashbot/projects/<id>/knowledge.jsonl */
  knowledge: string
  /** ~/.slashbot/projects/<id>/agents.json */
  agents: string
  /** ~/.slashbot/projects/<id>/file_locks.json */
  fileLocks: string
  /** ~/.slashbot/projects/<id>/mail.jsonl */
  mail: string
  /** ~/.slashbot/projects/<id>/config */
  configDir: string
  /** ~/.slashbot/projects/<id>/config/.slashbotrc */
  slashbotrc: string
  /** <projectRoot>/.worktrees */
  worktreesDir: string
  /** Path to .beads directory — prefers projectRoot/.beads if it exists, else storeDir/.beads */
  beadsRoot: string
  /** Parent directory of beadsRoot — use as cwd for bd CLI */
  beadsCwd: string
  /** ~/.slashbot/projects/<id>/config/AGENT.md */
  agentMd: string
}

function slashbotHome(): string {
  return path.join(os.homedir(), '.slashbot', 'projects')
}

export function getProjectPaths(projectPath: string): ProjectPaths {
  const absolute = path.resolve(projectPath)
  const hash8 = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  const id = `${path.basename(absolute)}-${hash8}`
  const storeDir = path.join(slashbotHome(), id)

  // Prefer projectRoot/.beads if it exists (where bd CLI creates it),
  // fall back to storeDir/.beads for centralized storage.
  const projectBeads = path.join(absolute, '.beads')
  const storeBeads = path.join(storeDir, '.beads')
  const beadsRoot = fs.existsSync(projectBeads) ? projectBeads : storeBeads

  return {
    id,
    projectRoot: absolute,
    storeDir,
    logsDir: path.join(storeDir, 'logs'),
    circuitBreakerState: path.join(storeDir, '.circuit_breaker_state'),
    callCount: path.join(storeDir, '.call_count'),
    activity: path.join(storeDir, 'activity.jsonl'),
    knowledge: path.join(storeDir, 'knowledge.jsonl'),
    agents: path.join(storeDir, 'agents.json'),
    fileLocks: path.join(storeDir, 'file_locks.json'),
    mail: path.join(storeDir, 'mail.jsonl'),
    configDir: path.join(storeDir, 'config'),
    slashbotrc: path.join(storeDir, 'config', '.slashbotrc'),
    worktreesDir: path.join(absolute, '.worktrees'),
    beadsRoot,
    beadsCwd: path.dirname(beadsRoot),
    agentMd: path.join(storeDir, 'config', 'AGENT.md'),
  }
}

export function ensureStoreDirs(paths: ProjectPaths): void {
  fs.mkdirSync(paths.storeDir, { recursive: true })
  fs.mkdirSync(paths.logsDir, { recursive: true })
  fs.mkdirSync(paths.configDir, { recursive: true })
}

