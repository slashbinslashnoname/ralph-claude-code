import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import type { ChildProcess } from 'child_process'
import { RalphConfig } from '../types'
import { AgentCoordinator } from './AgentCoordinator'
import { stripAnsi, buildEnv, resolveCmd } from './utils'

const MAX_ENCODE_RETRIES = 2
const HARD_CAP = 50

interface ValidationError {
  index: number
  id: string
  errors: string[]
}

interface ParseResult {
  count: number
  failures: number
}

export class PlanLoop extends EventEmitter {
  stopped = false
  private childProc: ChildProcess | null = null
  private slashbotDir: string
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
    this.slashbotDir = path.join(projectPath, '.slashbot')
    this.logDir = path.join(this.slashbotDir, 'logs')
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
      const raw = await this._runClaude(this._buildPlanPrompt(userRequest), 'plan', this.config.claudeModelThink)
      planMd = stripAnsi(raw)
      this._log('SUCCESS', `Plan ready (${planMd.length} chars)`)
    } catch (err) {
      this._log('ERROR', `Plan failed: ${err instanceof Error ? err.message : err}`)
      this.emit('error', err instanceof Error ? err.message : String(err))
      return
    }

    if (this.stopped) return

    // Step 2 — Encode to beads via bd (with validation + retry)
    this.emit('phase', 'encoding')
    this._log('INFO', 'Step 2 \u2014 Encoding plan to beads via bd CLI\u2026')
    try {
      let lastErrors: string[] = []
      for (let attempt = 0; attempt <= MAX_ENCODE_RETRIES; attempt++) {
        if (this.stopped) return
        if (attempt > 0) {
          this._log('INFO', `Encode retry ${attempt}/${MAX_ENCODE_RETRIES} \u2014 feeding ${lastErrors.length} validation errors back to Claude`)
        }

        const prompt = attempt === 0
          ? this._buildEncodePrompt(planMd, userRequest)
          : this._buildEncodeRetryPrompt(planMd, userRequest, lastErrors)

        const raw = await this._runClaude(prompt, `encode-attempt-${attempt}`, this.config.claudeModelExecute)
        const stripped = stripAnsi(raw)

        // Parse candidates for validation before creating
        const jsonMatch = stripped.match(/\[[\s\S]*\]/)
        if (!jsonMatch) {
          lastErrors = ['No JSON array found in encode response']
          if (attempt < MAX_ENCODE_RETRIES) continue
          this._log('WARN', 'No JSON array found after all retries')
          this.emit('phase', 'done')
          this.emit('done', 0)
          return
        }

        let candidates: Record<string, unknown>[]
        try {
          candidates = JSON.parse(jsonMatch[0])
        } catch (e) {
          lastErrors = [`JSON parse failed: ${e instanceof Error ? e.message : e}`]
          if (attempt < MAX_ENCODE_RETRIES) continue
          this._log('ERROR', lastErrors[0])
          this.emit('phase', 'done')
          this.emit('done', 0)
          return
        }

        const validationErrors = this._validateCandidates(candidates)
        if (validationErrors.length > 0) {
          lastErrors = validationErrors.map(
            ve => `Bead ${ve.index} (${ve.id}): ${ve.errors.join('; ')}`
          )
          this._log('WARN', `Validation found ${validationErrors.length} issues: ${lastErrors.join(' | ')}`)
          if (attempt < MAX_ENCODE_RETRIES) continue
          this._log('WARN', 'Proceeding despite validation errors after max retries')
        }

        const result = await this._parseAndCreateBeads(stripped)
        const total = result.count + result.failures
        if (total > 0 && result.failures / total > 0.2) {
          throw new Error(`High bead creation failure rate: ${result.failures}/${total} failed (>20%)`)
        }
        this._log('SUCCESS', `Beads created via bd: ${result.count} beads (${result.failures} failures)`)
        this.emit('phase', 'done')
        this.emit('done', result.count)
        return
      }
    } catch (err) {
      this._log('ERROR', `Encode failed: ${err instanceof Error ? err.message : err}`)
      this.emit('error', err instanceof Error ? err.message : String(err))
    }
  }

  private _runClaude(prompt: string, label: string, model?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--output-format', 'text',
        '--dangerously-skip-permissions']
      if (model) args.push('--model', model)
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = path.join(this.logDir, `planner_${label}_${ts}.log`)

      let proc: ChildProcess
      try {
        proc = cp.spawn(this.resolvedCmd, args, {
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
    const agentMd = path.join(this.slashbotDir, 'AGENT.md')
    const promptMd = path.join(this.slashbotDir, 'PROMPT.md')
    const context = [
      fs.existsSync(agentMd) ? fs.readFileSync(agentMd, 'utf8') : '',
      fs.existsSync(promptMd) ? fs.readFileSync(promptMd, 'utf8') : ''
    ].filter(Boolean).join('\n\n---\n\n')

    let currentBranch = ''
    try {
      currentBranch = cp.execSync('git rev-parse --abbrev-ref HEAD', {
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

  private _buildEncodeRetryPrompt(planMd: string, userRequest: string, errors: string[]): string {
    const base = this._buildEncodePrompt(planMd, userRequest)
    return `${base}

## PREVIOUS ATTEMPT FAILED VALIDATION

The following errors were found in your previous output. Fix ALL of them:

${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Output ONLY a valid JSON array. No markdown fences, no explanation.`
  }

  /** Validate candidate beads before creation */
  _validateCandidates(candidates: Record<string, unknown>[]): ValidationError[] {
    const errors: ValidationError[] = []

    if (candidates.length > HARD_CAP) {
      errors.push({ index: -1, id: '_batch_', errors: [`Batch too large: ${candidates.length} beads exceeds hard cap of ${HARD_CAP}`] })
    }

    // Gather batch IDs for dep resolution
    const batchIds = new Set(candidates.map(c => String(c.id ?? '')))

    // Gather live open bead IDs for dep resolution
    let liveOpenIds = new Set<string>()
    try {
      const openBeads = this.coordinator.bd.listAll()
        .filter((b: { status: string }) => b.status !== 'done')
      liveOpenIds = new Set(openBeads.map((b: { id: string }) => b.id))
    } catch { /* ignore */ }

    // Gather closed bead titles for duplicate detection
    let closedTitles = new Set<string>()
    try {
      const closedBeads = this.coordinator.bd.listAll()
        .filter((b: { status: string }) => b.status === 'done')
      closedTitles = new Set(closedBeads.map((b: { title: string }) => b.title.toLowerCase().trim()))
    } catch { /* ignore */ }

    // Soft ratio warning for large batches
    if (candidates.length > 20) {
      errors.push({ index: -1, id: '_batch_', errors: [`Large batch: ${candidates.length} beads (consider splitting)`] })
    }

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      const id = String(c.id ?? '')
      const beadErrors: string[] = []

      // Title validation: non-empty, > 3 chars
      const title = String(c.title ?? '')
      if (title.length <= 3) {
        beadErrors.push(`Title too short (${title.length} chars, need >3): "${title}"`)
      }

      // Description validation: non-empty, > 10 chars
      const desc = String(c.description ?? '')
      if (desc.length <= 10) {
        beadErrors.push(`Description too short (${desc.length} chars, need >10): "${desc}"`)
      }

      // Dep resolution: all deps must be in batch IDs or live open bead IDs
      const deps = Array.isArray(c.deps) ? c.deps.map(String) : []
      for (const dep of deps) {
        if (!batchIds.has(dep) && !liveOpenIds.has(dep)) {
          beadErrors.push(`Unresolvable dependency: "${dep}"`)
        }
      }

      // Duplicate detection vs closed beads
      if (closedTitles.has(title.toLowerCase().trim())) {
        beadErrors.push(`Duplicate of closed bead: "${title}"`)
      }

      if (beadErrors.length > 0) {
        errors.push({ index: i, id, errors: beadErrors })
      }
    }

    return errors
  }

  /** Parse JSON bead array from Claude output and create via bd CLI */
  private async _parseAndCreateBeads(raw: string): Promise<ParseResult> {
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      this._log('WARN', 'No JSON array found in encode response')
      return { count: 0, failures: 0 }
    }

    let parsed: Record<string, unknown>[]
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch (e) {
      this._log('ERROR', `JSON parse failed: ${e instanceof Error ? e.message : e}`)
      return { count: 0, failures: 0 }
    }

    const bd = this.coordinator.bd
    let created = 0
    let failures = 0
    const idMap = new Map<string, string>() // planned-id -> actual bd id

    // Create beads top-down so parent refs resolve: epics \u2192 tasks \u2192 subtasks
    const epics = parsed.filter(b => b.type === 'epic')
    const tasks = parsed.filter(b => b.type === 'task')
    const subtasks = parsed.filter(b => b.type === 'subtask')

    for (const group of [epics, tasks, subtasks]) {
      const plannedIds = group.map(b => String(b.id ?? ''))
      const opts = group.map(b => ({
        title: String(b.title ?? 'Untitled').slice(0, 120),
        type: String(b.type ?? 'task') as 'epic' | 'task' | 'subtask',
        priority: typeof b.priority === 'number' ? Math.min(4, Math.max(0, b.priority)) : 2,
        description: String(b.description ?? ''),
        labels: Array.isArray(b.tags) ? b.tags.map(String) : [],
        parentId: b.epicId ? idMap.get(String(b.epicId)) : undefined,
      }))

      const { created: groupCreated, failed: groupFailed } = await bd.createMany(opts)

      // Map planned IDs to actual bd IDs for dependency wiring.
      // createMany preserves input order: each input either ends up in created or failed.
      let ci = 0
      for (let i = 0; i < opts.length; i++) {
        const isFailed = groupFailed.some(f => f.opts === opts[i])
        if (!isFailed && ci < groupCreated.length) {
          idMap.set(plannedIds[i], groupCreated[ci].id)
          ci++
        }
      }

      created += groupCreated.length
      failures += groupFailed.length
      for (const f of groupFailed) {
        this._log('WARN', `Failed to create bead "${f.opts.title}": ${f.error}`)
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

    this.coordinator.postActivity({
      agentId: this.agentId,
      type: 'info' as any,
      summary: `${created} beads created via bd CLI`
    })

    return { count: created, failures }
  }

  private _log(level: string, msg: string): void {
    this.emit('log', level, msg)
  }
}
