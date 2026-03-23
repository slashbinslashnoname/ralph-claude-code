import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export interface ProjectPaths {
  /** SHA256 hex digest of the absolute project path */
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
  /** ~/.slashbot/projects/<id>/config */
  configDir: string
  /** <projectRoot>/.worktrees */
  worktreesDir: string
  /** <projectRoot>/.beads */
  beadsRoot: string
  /** ~/.slashbot/projects/<id>/config/AGENT.md */
  agentMd: string
}

function slashbotHome(): string {
  return path.join(os.homedir(), '.slashbot', 'projects')
}

export function getProjectPaths(projectPath: string): ProjectPaths {
  const absolute = path.resolve(projectPath)
  const id = crypto.createHash('sha256').update(absolute).digest('hex')
  const storeDir = path.join(slashbotHome(), id)

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
    configDir: path.join(storeDir, 'config'),
    worktreesDir: path.join(absolute, '.worktrees'),
    beadsRoot: path.join(absolute, '.beads'),
    agentMd: path.join(storeDir, 'config', 'AGENT.md'),
  }
}

export function ensureStoreDirs(paths: ProjectPaths): void {
  fs.mkdirSync(paths.storeDir, { recursive: true })
  fs.mkdirSync(paths.logsDir, { recursive: true })
  fs.mkdirSync(paths.configDir, { recursive: true })
}

const LEGACY_FILES = [
  '.circuit_breaker_state',
  '.call_count',
  'activity.jsonl',
  'knowledge.jsonl',
  'agents.json',
  'file_locks.json',
]

export function detectLegacyStorage(projectPath: string): boolean {
  const legacyDir = path.join(projectPath, '.slashbot')
  if (!fs.existsSync(legacyDir)) return false

  for (const file of LEGACY_FILES) {
    if (fs.existsSync(path.join(legacyDir, file))) return true
  }

  const logsDir = path.join(legacyDir, 'logs')
  if (fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory()) {
    const entries = fs.readdirSync(logsDir)
    if (entries.length > 0) return true
  }

  return false
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry)
    const destPath = path.join(dest, entry)
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export function migrateLegacyStorage(projectPath: string): { migrated: string[]; skipped: string[] } {
  const legacyDir = path.join(projectPath, '.slashbot')
  const paths = getProjectPaths(projectPath)
  ensureStoreDirs(paths)

  const migrated: string[] = []
  const skipped: string[] = []

  for (const file of LEGACY_FILES) {
    const src = path.join(legacyDir, file)
    const dest = path.join(paths.storeDir, file)
    if (!fs.existsSync(src)) continue

    if (fs.existsSync(dest)) {
      skipped.push(file)
    } else {
      fs.copyFileSync(src, dest)
      migrated.push(file)
    }
  }

  // Handle logs/ directory
  const srcLogs = path.join(legacyDir, 'logs')
  if (fs.existsSync(srcLogs) && fs.statSync(srcLogs).isDirectory()) {
    const entries = fs.readdirSync(srcLogs)
    if (entries.length > 0) {
      copyDirRecursive(srcLogs, paths.logsDir)
      migrated.push('logs/')
    }
  }

  return { migrated, skipped }
}
