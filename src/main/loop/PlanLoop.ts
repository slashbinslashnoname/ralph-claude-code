import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import type { ChildProcess } from 'child_process'
import { RalphConfig } from '../types'
import { AgentCoordinator } from './AgentCoordinator'
import { stripAnsi, buildEnv, resolveCmd } from './utils'
import { ProjectPaths } from './ProjectStore'

export class PlanLoop extends EventEmitter {
  stopped = false
  private childProc: ChildProcess | null = null
  private paths: ProjectPaths
  private logDir: string
  private env: NodeJS.ProcessEnv
  private resolvedCmd: string

  // ── Human-in-the-loop state ─────────────────────────────────────────────
  private _pendingPlanMd: string | null = null
  private _pendingRequest: string | null = null
  private _approveResolve: ((plan: string | null) => void) | null = null

  constructor(
    paths: ProjectPaths,
    private config: RalphConfig,
    private coordinator: AgentCoordinator,
    private agentId = 'planner'
  ) {
    super()
    this.paths = paths
    this.logDir = paths.logsDir
    this.env = buildEnv()
    this.resolvedCmd = resolveCmd(config.claudeCodeCmd, this.env)
    fs.mkdirSync(this.logDir, { recursive: true })
  }

  stop(): void {
    this.stopped = true
    if (this.childProc) try { this.childProc.kill('SIGTERM') } catch { /* ignore */ }
    if (this._approveResolve) {
      this._approveResolve(null)
      this._approveResolve = null
    }
  }

  approvePlan(modifiedPlan?: string): void {
    if (!this._approveResolve) return
    const plan = modifiedPlan?.trim() || this._pendingPlanMd
    this._approveResolve(plan)
    this._approveResolve = null
    this._pendingPlanMd = null
  }

  rejectPlan(): void {
    if (!this._approveResolve) return
    this._approveResolve(null)
    this._approveResolve = null
    this._pendingPlanMd = null
  }

  get pendingApproval(): boolean {
    return this._approveResolve !== null
  }

  get pendingPlanMarkdown(): string | null {
    return this._pendingPlanMd
  }

  get pendingRequest(): string | null {
    return this._pendingRequest
  }

  async run(userRequest: string): Promise<void> {
    this._log('INFO', `━━ PlanLoop: resolved claude cmd: ${this.resolvedCmd} ━━`)
    this._pendingRequest = userRequest

    // Step 1 — Single plan generation
    this.emit('phase', 'planning')
    this._log('INFO', 'Step 1 — Generating plan…')
    let planMd = ''
    try {
      const raw = await this._runClaude(this._buildPlanPrompt(userRequest), 'plan', this.config.claudeModelThink)
      planMd = stripAnsi(raw)
      this._log('SUCCESS', `Plan ready (${planMd.length} chars)`)
    } catch (err) {
      this._log('ERROR', `Plan failed: ${err instanceof Error ? err.message : err}`)
      this.emit('error', err instanceof Error ? err.message : String(err))
      return
    }

    if (this.stopped) return

    // Step 2 — Human-in-the-loop review
    this._pendingPlanMd = planMd
    this.emit('phase', 'review')
    this.emit('planThinking', planMd, userRequest)
    this._log('INFO', 'Step 2 — Plan submitted for human review. Waiting for approval…')

    const approvedPlan = await new Promise<string | null>((resolve) => {
      this._approveResolve = resolve
    })

    if (this.stopped || approvedPlan === null) {
      this._log('INFO', 'Plan rejected or cancelled')
      this.emit('phase', 'done')
      this.emit('done', 0)
      this._pendingRequest = null
      return
    }
    planMd = approvedPlan
    this._log('SUCCESS', 'Plan approved — proceeding to encode')

    // Step 3 — Claude encodes plan to beads directly via bd CLI
    this.emit('phase', 'encoding')
    this._log('INFO', 'Step 3 — Encoding plan to beads via bd CLI…')
    try {
      let beforeCount = 0
      try { beforeCount = this.coordinator.bd.listAll().length } catch { /* ignore */ }

      await this._encodePlanInBatches(planMd, userRequest)

      let afterCount = 0
      try { afterCount = this.coordinator.bd.listAll().length } catch { /* ignore */ }
      const created = Math.max(0, afterCount - beforeCount)

      if (created === 0) {
        this._log('WARN', 'No beads produced from encoding')
      } else {
        this._log('SUCCESS', `Beads created via bd: ${created} beads`)
      }
      this.emit('phase', 'done')
      this.emit('done', created)
    } catch (err) {
      this._log('ERROR', `Encode failed: ${err instanceof Error ? err.message : err}`)
      this.emit('error', err instanceof Error ? err.message : String(err))
    }
    this._pendingRequest = null
  }

  /** Split plan into sections and encode each batch via Claude calling bd directly. */
  private async _encodePlanInBatches(planMd: string, userRequest: string): Promise<void> {
    const sections = this._splitPlanSections(planMd)
    if (sections.length <= 1) {
      await this._encodeSingleBatch(planMd, userRequest, 'batch-0')
      return
    }

    this._log('INFO', `Plan split into ${sections.length} sections for batch encoding`)

    for (let i = 0; i < sections.length; i++) {
      if (this.stopped) return
      this._log('INFO', `Encoding batch ${i + 1}/${sections.length}…`)
      await this._encodeSingleBatch(sections[i], userRequest, `batch-${i}`)
    }
  }

  /** Encode a single section — Claude calls bd CLI directly to create beads. */
  private async _encodeSingleBatch(
    sectionMd: string,
    userRequest: string,
    label: string,
  ): Promise<void> {
    if (this.stopped) return
    const prompt = this._buildEncodePrompt(sectionMd, userRequest)
    await this._runClaude(prompt, label, this.config.claudeModelExecute)
  }

  /** Split plan markdown into logical sections by top-level headings. */
  private _splitPlanSections(planMd: string): string[] {
    const lines = planMd.split('\n')
    const sections: string[] = []
    let current: string[] = []

    for (const line of lines) {
      if (/^#{1,2}\s/.test(line) && current.length > 0) {
        sections.push(current.join('\n'))
        current = []
      }
      current.push(line)
    }
    if (current.length > 0) sections.push(current.join('\n'))

    // Merge small sections to avoid too many tiny batches
    const merged: string[] = []
    let buf = ''
    for (const s of sections) {
      if (buf && (buf + '\n' + s).split('\n').length > 80) {
        merged.push(buf)
        buf = s
      } else {
        buf = buf ? buf + '\n' + s : s
      }
    }
    if (buf) merged.push(buf)

    return merged
  }

  private _runClaude(prompt: string, label: string, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--output-format', 'stream-json',
        '--verbose', '--dangerously-skip-permissions']
      if (model) args.push('--model', model)
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = path.join(this.logDir, `planner_${label}_${ts}.log`)

      let proc: ChildProcess
      try {
        proc = cp.spawn(this.resolvedCmd, args, {
          cwd: this.paths.projectRoot, env: this.env, stdio: ['ignore', 'pipe', 'pipe']
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
          reject(new Error(`PlanLoop: Claude exited ${exitCode}${errOut.trim() ? ` — ${errOut.trim().slice(0, 300)}` : ''}`))
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
    const agentMd = this.paths.agentMd
    const promptMd = path.join(this.paths.configDir, 'PROMPT.md')
    const context = [
      fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : '',
      fs.existsSync(promptMd) ? fs.readFileSync(promptMd, 'utf8') : ''
    ].filter(Boolean).join('\n\n---\n\n')

    let currentBranch = ''
    try {
      currentBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.paths.projectRoot, timeout: 3000
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

1. **Architecture overview** — key components, data flows, interfaces
2. **Workflow breakdown** — ordered phases with clear milestones and deliverables
3. **Testing strategy** — unit, integration, e2e
4. **Dependencies** — external libs needed, internal module order
5. **Risk areas** — things that could go wrong, mitigations

Be specific. Reference actual file names from the codebase. No implementation code — architecture and decisions only.
Output ONLY the plan as clean Markdown.

## CASS Memory (\`cm\` CLI)
Before planning, retrieve relevant knowledge from CASS memory:
\`\`\`
cm context "brief description of the task" --limit 30
\`\`\`
This returns relevant rules, anti-patterns, and historical context. Use it to inform your plan.
If \`cm\` is not installed, skip silently and proceed.`
  }

  private _buildEncodePrompt(
    sectionMd: string,
    userRequest: string,
  ): string {
    // Fetch existing open beads so Claude can reference them
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

    return `You are a task encoder. Convert the plan section below into beads by running \`bd\` CLI commands directly.

## bd CLI reference

Create a bead:
\`\`\`
bd create "Short imperative title" -t <epic|task|subtask> -p <0-4> -d "Description of what needs to be done" --json
\`\`\`
Options:
- \`-t\`: type — \`epic\` (groups related work), \`task\` (implementation unit), \`subtask\` (breakdown of a task)
- \`-p\`: priority — 0 (critical) → 1 (high) → 2 (normal) → 3 (low) → 4 (nice-to-have)
- \`-d\`: description — what needs to be done, 1-3 sentences
- \`-l\`: labels — comma-separated tags (e.g. \`-l "backend,api"\`)
- \`--parent\`: parent epic ID for tasks/subtasks
- \`--json\`: **always use this flag** so you can read the created bead's ID from the output

Add a dependency (B blocks A — A cannot start until B is done):
\`\`\`
bd dep add <blocked-id> <blocker-id>
\`\`\`

## Workflow
1. Create epics first — read their IDs from the \`--json\` output
2. Create tasks/subtasks with \`--parent <epic-id>\`
3. Wire dependencies with \`bd dep add\`

## Original request
${userRequest}

## Plan section to encode
${sectionMd}
${existingBeads ? `
## Existing open beads (already in the system)
${existingBeads}

Do NOT recreate beads that already exist — reference their ID in deps instead.
` : ''}
## Rules
- Focus on the most important work in this section. Merge small, related items into single beads.
- Create epics before their children so parent IDs are available.
- Read the JSON output of each \`bd create --json\` to get the actual bead ID before using it in \`--parent\` or \`bd dep add\`.
- If a \`bd\` command fails, log the error and continue with the next bead — do not stop.
- If you encounter a test failure or issue outside the scope of the current plan, create a bead for it (type: task, label: "fix-later") so it gets tracked and addressed separately.
- Do NOT output raw JSON yourself — use the \`bd\` CLI to create everything directly.

## CASS Memory (\`cm\` CLI)
Before encoding, retrieve relevant knowledge from CASS memory:
\`\`\`
cm context "brief description of the task" --limit 30
\`\`\`
This returns relevant rules, anti-patterns, and historical context. Use it to inform your encoding.
If \`cm\` is not installed, skip silently and proceed.`
  }

  private _log(level: string, msg: string): void {
    this.emit('log', level, msg)
  }
}
