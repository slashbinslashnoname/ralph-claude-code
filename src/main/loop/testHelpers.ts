import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execSync } from 'child_process'
import { ProjectPaths } from './ProjectStore'

/** Create a temporary git repo with an initial commit and .beads directory. */
export function makeTmpGitProject(prefix = 'slashbot-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  fs.writeFileSync(path.join(dir, 'README.md'), '# test')
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' })

  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true })
  return dir
}

/** Build a ProjectPaths pointing storeDir inside the tmp project (co-located for test simplicity). */
export function makeTmpPaths(projectDir: string): ProjectPaths {
  const storeDir = path.join(projectDir, '.slashbot')
  fs.mkdirSync(path.join(storeDir, 'logs'), { recursive: true })
  return {
    id: 'test-id',
    projectRoot: projectDir,
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
    worktreesDir: path.join(projectDir, '.worktrees'),
    beadsRoot: path.join(projectDir, '.beads'),
    beadsCwd: projectDir,
    agentMd: path.join(storeDir, 'config', 'AGENT.md'),
    promptMd: path.join(storeDir, 'config', 'PROMPT.md'),
  }
}
