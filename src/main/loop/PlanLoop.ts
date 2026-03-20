import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, execSync, ChildProcess } from 'child_process'
import { RalphConfig } from '../types'
import { AgentCoordinator } from './AgentCoordinator'

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '').replace(/\x1B[=>]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function buildEnv(): NodeJS.ProcessEnv {
  const extras = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${process.env.HOME ?? ''}/.local/bin`, `${process.env.HOME ?? ''}/.npm-global/bin`,
    `${process.env.HOME ?? ''}/.volta/bin`, `${process.env.HOME ?? ''}/.cargo/bin`]
  let loginPath = ''
  try { loginPath = execSync('bash -l -c "echo $PATH"', { timeout: 3000 }).toString().trim() } catch { /* ignore */ }
  const merged = [...new Set(
    [process.env.PATH ?? '', loginPath, ...extras].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  return { ...process.env, PATH: merged }
}

function resolveCmd(cmd: string, env: NodeJS.ProcessEnv): string {
  if (cmd.startsWith('/') && fs.existsSync(cmd)) return cmd
  try {
    const r = execSync(`which ${cmd}`, { env, timeout: 3000 }).toString().trim()
    if (r.startsWith('/')) return r
  } catch { /* ignore */ }
  return cmd
}

export class PlanLoop extends EventEmitter {
  stopped = false
  private childProc: ChildProcess | null = null
  private ralphDir: string
  private logDir: string
  private env: NodeJS.ProcessEnv
  private resolvedCmd: string

  constructor(
    private projectPath: string,
    private config: RalphConfig,
    private coordinator: AgentCoordinator,
    private agentId = 'planner'
  ) {
    super()
    this.ralphDir = path.join(projectPath, '.ralph')
    this.logDir = path.join(this.ralphDir, 'logs')
    this.env = buildEnv()
    this.resolvedCmd = resolveCmd(config.claudeCodeCmd, this.env)
    fs.mkdirSync(this.logDir, { recursive: true })
  }

  stop(): void {
    this.stopped = true
    if (this.childProc) try { this.childProc.kill('SIGTERM') } catch { /* ignore */ }
  }

  async run(userRequest: string): Promise<void> {
    this._log('INFO', `\u2501\u2501 PlanLoop: resolved claude cmd: ${this.resolvedCmd} \u2501\u2501`)

    // Step 1 — Single plan generation
    this.emit('phase', 'planning')
    this._log('INFO', 'Step 1 \u2014 Generating plan\u2026')
    let planMd = ''
    try {
      const raw = await this._runClaude(this._buildPlanPrompt(userRequest), 'plan')
      planMd = stripAnsi(raw)
      this._log('SUCCESS', `Plan ready (${planMd.length} chars)`)
    } catch (err) {
      this._log('ERROR', `Plan failed: ${err instanceof Error ? err.message : err}`)
      this.emit('error', err instanceof Error ? err.message : String(err))
      return
    }

    if (this.stopped) return

    // Step 2 — Encode to beads via bd
    this.emit('phase', 'encoding')
    this._log('INFO', 'Step 2 \u2014 Encoding plan to beads via bd CLI\u2026')
    try {
      const raw = await this._runClaude(this._buildEncodePrompt(planMd, userRequest), 'encode')
      const beadCount = await this._parseAndCreateBeads(stripAnsi(raw))
      this._log('SUCCESS', `Beads created via bd: ${beadCount} beads`)
      this.emit('phase', 'done')
      this.emit('done', beadCount)
    } catch (err) {
      this._log('ERROR', `Encode failed: ${err instanceof Error ? err.message : err}`)
      this.emit('error', err instanceof Error ? err.message : String(err))
    }
  }

  private _runClaude(prompt: string, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--output-format', 'text',
        '--dangerously-skip-permissions']
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = path.join(this.logDir, `planner_${label}_${ts}.log`)

      let proc: ChildProcess
      try {
        proc = spawn(this.resolvedCmd, args, {
          cwd: this.projectPath, env: this.env, stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(new Error(`PlanLoop spawn failed: ${err instanceof Error ? err.message : err}`))
        return
      }
      this.childProc = proc
      let raw = ''
      let errOut = ''

      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        if (raw.trim()) resolve(raw)
        else reject(new Error('PlanLoop: timed out'))
      }, this.config.claudeTimeoutMinutes * 60_000 * 3)

      proc.stdout!.on('data', (chunk: Buffer) => {
        const s = chunk.toString(); raw += s
        this.emit('output', s)
        fs.appendFileSync(outFile, s)
      })
      proc.stderr!.on('data', (chunk: Buffer) => {
        const s = chunk.toString(); errOut += s
        fs.appendFileSync(outFile, s)
      })
      proc.on('close', (exitCode) => {
        clearTimeout(timer); this.childProc = null
        if (this.stopped) { resolve(raw); return }
        if (exitCode !== 0 && !raw.trim()) {
          reject(new Error(`PlanLoop: Claude exited ${exitCode}${errOut.trim() ? ` \u2014 ${errOut.trim().slice(0, 300)}` : ''}`))
          return
        }
        resolve(raw)
      })
      proc.on('error', (err) => {
        clearTimeout(timer); this.childProc = null
        reject(new Error(`PlanLoop spawn failed: ${err.message}`))
      })
    })
  }

  private _buildPlanPrompt(request: string): string {
    const agentMd = path.join(this.ralphDir, 'AGENT.md')
    const promptMd = path.join(this.ralphDir, 'PROMPT.md')
    const context = [
      fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : '',
      fs.existsSync(promptMd) ? fs.readFileSync(promptMd, 'utf8') : ''
    ].filter(Boolean).join('\n\n---\n\n')

    let currentBranch = ''
    try {
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 3000
      }).toString().trim()
    } catch { /* ignore */ }

    return `ULTRATHINK

You are a senior software architect. Think deeply before writing anything.

## Working branch: \`${currentBranch}\`
Base all analysis on files currently on disk. Do not use git history.

## Mandatory codebase exploration (do this FIRST)
1. List the project structure with \`ls\` and \`find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*'\`
2. Read the key files — entry points, core modules, config files
3. Understand: architecture, patterns, naming conventions, test framework, build system
4. Identify: what exists and works, what is partial, what is missing, what will break

Take your time. Read broadly. The quality of the plan depends entirely on understanding the codebase first.

${context ? `## Project brief\n${context}\n\n` : ''}## User request
${request}

## Plan requirements
Write ONE detailed, actionable development plan. Think about second-order effects:

1. **Architecture overview** \u2014 key components, data flows, interfaces
2. **Workflow breakdown** \u2014 ordered phases with clear milestones and deliverables
3. **Testing strategy** \u2014 unit, integration, e2e
4. **Dependencies** \u2014 external libs needed, internal module order
5. **Risk areas** \u2014 things that could go wrong, mitigations

Be specific. Reference actual file names from the codebase. No implementation code \u2014 architecture and decisions only.
Output ONLY the plan as clean Markdown.`
  }

  private _buildEncodePrompt(planMd: string, userRequest: string): string {
    // Fetch existing open beads so new beads can be ordered relative to them
    let existingBeads = ''
    try {
      const open = this.coordinator.bd.listAll()
        .filter(b => b.status === 'ready' || b.status === 'claimed' || b.status === 'pending')
      if (open.length > 0) {
        existingBeads = open.map(b =>
          `- [${b.id}] P${b.priority} ${b.type} ${b.status} "${b.title}"${b.deps.length > 0 ? ` deps:[${b.deps.join(',')}]` : ''}`
        ).join('\n')
      }
    } catch { /* ignore */ }

    return `ULTRATHINK

Convert a development plan into a structured bead dependency graph.
Think deeply about hierarchy, importance, and execution order.

## Original request
${userRequest}

## Synthesized plan
${planMd}
${existingBeads ? `
## Existing open beads (already in the system)
${existingBeads}

New beads MUST account for these. Set dependencies on existing beads where appropriate.
Do NOT recreate beads that already exist — reference their ID in deps instead.
` : ''}
## Your task
Create a well-structured bead graph. Agents pick beads with **zero unresolved deps first** (leaf work), then move up the dependency chain. Within same dep count, priority breaks ties (P0 before P1).

Output a **JSON array** of beads:
\`\`\`json
{
  "id": "bead-001",
  "title": "Short imperative title (< 60 chars)",
  "description": "What exactly needs to be implemented, 1-3 sentences",
  "type": "epic|task|subtask",
  "priority": 2,
  "deps": ["bead-001"],
  "files": ["src/foo.ts"],
  "epicId": "bead-001",
  "tags": ["backend", "api"]
}
\`\`\`

Rules:
- **Hierarchy**: epics group related work, tasks are implementation units, subtasks break complex tasks down.
- **deps**: array of bead IDs that MUST be completed first. Empty = no blockers, picked first. Use deps to express ALL ordering constraints — e.g. a task that needs another task done first, an epic that needs all its tasks done. Agents always pick beads with the fewest unresolved deps.
- **priority**: 0 (critical/blocking) → 1 (high) → 2 (normal) → 3 (low) → 4 (nice-to-have). Breaks ties when dep counts are equal.
- **type**: epic, task, or subtask.
- **epicId**: parent epic ID for tasks/subtasks.
- Set P0 for foundational/blocking work (schema, config, core interfaces).
- Set P1 for main feature implementation.
- Set P2+ for polish, docs, edge cases.
- Beads with unresolved deps are blocked — agents skip them automatically.

Output ONLY a valid JSON array. No markdown fences, no explanation.`
  }

  /** Parse JSON bead array from Claude output and create via bd CLI */
  private async _parseAndCreateBeads(raw: string): Promise<number> {
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      this._log('WARN', 'No JSON array found in encode response')
      return 0
    }

    let parsed: Record<string, unknown>[]
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch (e) {
      this._log('ERROR', `JSON parse failed: ${e instanceof Error ? e.message : e}`)
      return 0
    }

    const bd = this.coordinator.bd
    let created = 0
    const idMap = new Map<string, string>() // planned-id -> actual bd id

    // Create beads top-down so parent refs resolve: epics → tasks → subtasks
    const epics = parsed.filter(b => b.type === 'epic')
    const tasks = parsed.filter(b => b.type === 'task')
    const subtasks = parsed.filter(b => b.type === 'subtask')

    for (const group of [epics, tasks, subtasks]) {
      for (const b of group) {
        try {
          const bdType = String(b.type ?? 'task') as 'epic' | 'task' | 'subtask'
          const parentId = b.epicId ? idMap.get(String(b.epicId)) : undefined
          const result = await bd.createAsync({
            title: String(b.title ?? 'Untitled').slice(0, 120),
            type: bdType,
            priority: typeof b.priority === 'number' ? Math.min(4, Math.max(0, b.priority)) : 2,
            description: String(b.description ?? ''),
            labels: Array.isArray(b.tags) ? b.tags.map(String) : [],
            parentId,
          })
          idMap.set(String(b.id ?? ''), result.id)
          created++
        } catch (err) {
          this._log('WARN', `Failed to create ${b.type} "${b.title}": ${err instanceof Error ? err.message : err}`)
        }
      }
    }

    // Wire up dependencies
    for (const b of parsed) {
      const childId = idMap.get(String(b.id ?? ''))
      const deps = Array.isArray(b.deps) ? b.deps.map(String) : []
      for (const dep of deps) {
        const parentId = idMap.get(dep)
        if (childId && parentId) {
          try { bd.addDep(childId, parentId) } catch { /* ignore */ }
        }
      }
    }

    this.coordinator.post({
      from: this.agentId,
      type: 'info',
      text: `${created} beads created via bd CLI`
    })

    return created
  }

  private _log(level: string, msg: string): void {
    this.emit('log', level, msg)
  }
}
