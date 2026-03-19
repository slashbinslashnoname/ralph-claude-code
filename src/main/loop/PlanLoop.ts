/**
 * PlanLoop.ts — Steps 1 & 2 of the swarm workflow.
 *
 * Step 1 — Plan:
 *   Calls Claude 3 times in parallel with different planning angles,
 *   then calls Claude once more to synthesize the three plans into one.
 *   Output: `.ralph/plan.md`
 *
 * Step 2 — Encode:
 *   Calls Claude with the synthesized plan and asks it to produce a
 *   dependency graph of 50–500 self-contained beads as JSON.
 *   Output: `.ralph/beads.json`
 *
 * Triggered by: user injecting new tasks OR first-time setup.
 */

import { EventEmitter } from 'events'
import * as pty          from 'node-pty'
import { IPty }          from 'node-pty'
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join }          from 'path'
import { execSync }      from 'child_process'

import { AgentCoordinator }       from './AgentCoordinator'
import { BeadGraph, initGraph, saveGraph, upsertBead } from './Bead'
import { RalphConfig }            from './types'
import type { Bead, BeadType, BeadStatus } from './Bead'

// ── Helpers ────────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][AB012]/g, '')
    .replace(/\x1B[=>]/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function buildEnv(): Record<string, string> {
  const extras = [
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    `${process.env.HOME ?? ''}/.local/bin`,
    `${process.env.HOME ?? ''}/.npm-global/bin`,
    `${process.env.HOME ?? ''}/.volta/bin`,
  ]
  const merged = [...new Set(
    [process.env.PATH ?? '', ...extras].flatMap(p => p.split(':').filter(Boolean))
  )].join(':')
  return { ...process.env, PATH: merged } as Record<string, string>
}

function resolveCmd(cmd: string, env: Record<string, string>): string {
  if (cmd.startsWith('/')) {
    if (existsSync(cmd)) return cmd
    cmd = cmd.split('/').pop() ?? cmd
  }
  try {
    const r = execSync(`which ${cmd}`, { env, timeout: 3000 }).toString().trim()
    if (r.startsWith('/')) return r
  } catch { /* ignore */ }
  return cmd
}

// ── PlanLoop events ────────────────────────────────────────────────────────

export interface PlanEvents {
  log:    (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string) => void
  output: (chunk: string) => void
  phase:  (phase: 'planning-1' | 'planning-2' | 'planning-3' | 'synthesizing' | 'encoding' | 'done') => void
  done:   (beadCount: number) => void
  error:  (message: string) => void
}

interface TypedEmitter extends EventEmitter {
  on<K extends keyof PlanEvents>(event: K, listener: PlanEvents[K]): this
  emit<K extends keyof PlanEvents>(event: K, ...args: Parameters<PlanEvents[K]>): boolean
}

// ── PlanLoop ───────────────────────────────────────────────────────────────

export class PlanLoop extends (EventEmitter as new () => TypedEmitter) {
  private stopped       = false
  private ptyProc: IPty | null = null

  private readonly ralphDir:    string
  private readonly logDir:      string
  private readonly env:         Record<string, string>
  private readonly resolvedCmd: string

  constructor(
    private readonly projectPath:   string,
    private readonly config:        RalphConfig,
    private readonly coordinator:   AgentCoordinator,
    private readonly agentId = 'planner'
  ) {
    super()
    this.ralphDir    = join(projectPath, '.ralph')
    this.logDir      = join(this.ralphDir, 'logs')
    this.env         = buildEnv()
    this.resolvedCmd = resolveCmd(config.claudeCodeCmd, this.env)
    mkdirSync(this.logDir, { recursive: true })
  }

  stop(): void {
    this.stopped = true
    if (this.ptyProc) {
      try { this.ptyProc.kill('SIGTERM') } catch { /* ignore */ }
    }
  }

  // ── Entry point ────────────────────────────────────────────────────────

  async run(userRequest: string): Promise<void> {
    this._log('INFO', '━━ PlanLoop: Step 1 — Generating 3 competing plans ━━')

    // ── Step 1: Three competing plans ─────────────────────────────────────
    const angles = [
      { label: 'plan-1', angle: 'speed-first', description: 'optimise for the fastest path to a working MVP, minimal dependencies' },
      { label: 'plan-2', angle: 'quality-first', description: 'optimise for correctness, test coverage, and long-term maintainability' },
      { label: 'plan-3', angle: 'architecture-first', description: 'optimise for clean boundaries, extensibility, and parallel workstreams' },
    ]

    const plans: string[] = []
    for (const { label, angle, description } of angles) {
      if (this.stopped) return
      this.emit('phase', label as PlanEvents['phase'] extends (p: infer P) => void ? P : never)
      this._log('INFO', `Step 1 — ${label}: ${angle}`)
      const prompt = this._buildPlanPrompt(userRequest, angle, description)
      try {
        const raw = await this._runClaude(prompt, label)
        plans.push(`## Plan angle: ${angle}\n\n${stripAnsi(raw)}`)
        this._log('INFO', `${label} complete (${raw.length} bytes)`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this._log('WARN', `${label} failed: ${msg} — using empty plan`)
        plans.push(`## Plan angle: ${angle}\n\n(generation failed: ${msg})`)
      }
    }

    if (this.stopped) return

    // ── Step 1 synthesis ──────────────────────────────────────────────────
    this.emit('phase', 'synthesizing')
    this._log('INFO', 'Step 1 — Synthesizing 3 plans into one…')
    let planMd = ''
    try {
      const raw = await this._runClaude(this._buildSynthesisPrompt(plans), 'synthesis')
      planMd = stripAnsi(raw)
      writeFileSync(join(this.ralphDir, 'plan.md'), planMd)
      this._log('SUCCESS', `Plan saved (${planMd.length} chars)`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this._log('ERROR', `Synthesis failed: ${msg}`)
      this.emit('error', msg)
      return
    }

    if (this.stopped) return

    // ── Step 2: Encode to beads ────────────────────────────────────────────
    this.emit('phase', 'encoding')
    this._log('INFO', 'Step 2 — Encoding plan to bead dependency graph…')
    try {
      const raw = await this._runClaude(this._buildEncodePrompt(planMd, userRequest), 'encode')
      const beadCount = this._parseAndSaveBeads(planMd, stripAnsi(raw))
      this._log('SUCCESS', `Bead graph saved: ${beadCount} beads`)
      this.emit('phase', 'done')
      this.emit('done', beadCount)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this._log('ERROR', `Encode failed: ${msg}`)
      this.emit('error', msg)
    }
  }

  // ── Claude invocation ─────────────────────────────────────────────────────

  private _runClaude(prompt: string, label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use text output + ultrathink flag (extended thinking) for planning steps.
      // --ultrathink instructs the Claude CLI to use maximum extended thinking budget.
      const args    = [
        '-p', prompt,
        '--output-format', 'text',
        '--allowedTools', 'Read,Bash(find *),Bash(ls *),Bash(cat *),Bash(grep *)',
        '--ultrathink',
      ]
      const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outFile = join(this.logDir, `planner_${label}_${ts}.log`)

      let proc: IPty
      try {
        proc = pty.spawn(this.resolvedCmd, args, {
          name: 'xterm-256color', cols: 220, rows: 50,
          cwd: this.projectPath, env: this.env
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        reject(new Error(`PlanLoop spawn failed: ${msg}`))
        return
      }

      this.ptyProc = proc
      let raw = ''

      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* ignore */ }
        if (raw.trim()) resolve(raw)
        else reject(new Error('PlanLoop: timed out with no output'))
      }, this.config.claudeTimeoutMinutes * 60_000 * 3)  // 3x timeout for planning

      proc.onData(chunk => {
        raw += chunk
        this.emit('output', chunk)
        appendFileSync(outFile, chunk)
      })

      proc.onExit(({ exitCode }) => {
        clearTimeout(timer)
        this.ptyProc = null
        if (this.stopped) { resolve(raw); return }
        if (exitCode !== 0 && !raw.trim()) {
          reject(new Error(`PlanLoop: Claude exited ${exitCode} with no output`))
          return
        }
        resolve(raw)
      })
    })
  }

  // ── Prompt builders ───────────────────────────────────────────────────────

  private _buildPlanPrompt(request: string, angle: string, description: string): string {
    const agentMd  = join(this.ralphDir, 'AGENT.md')
    const promptMd = join(this.ralphDir, 'PROMPT.md')
    const context  = [
      existsSync(agentMd)  ? readFileSync(agentMd,  'utf8') : '',
      existsSync(promptMd) ? readFileSync(promptMd, 'utf8') : '',
    ].filter(Boolean).join('\n\n---\n\n')

    return `ULTRATHINK

You are a senior software architect. Before writing a single word of your plan, you MUST spend significant time exploring and deeply understanding the existing codebase. Do not skip this step.

## Mandatory codebase exploration (do this FIRST, before planning)
1. Run \`find . -type f -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.rs" | head -100\` to map all source files
2. Read every key file you find — src/, lib/, tests/, package.json / go.mod / Cargo.toml, existing configs
3. Understand: existing architecture, patterns, naming conventions, test framework, build system
4. Identify: what already exists, what is partially done, what is completely missing
5. Note: any tech debt, inconsistencies, or risks in the current code

ONLY after you have read the codebase thoroughly should you write your plan.
Take as much time as you need. Think deeply. Do not rush.

## Your planning angle: **${angle}**
${description}

${context ? `## Project brief\n${context}\n\n` : ''}## User request
${request}

## Plan requirements
Write a detailed development plan from the "${angle}" perspective that:

1. **Architecture overview** — key components, data flows, interfaces
   - Build on existing code where possible, replace/refactor only when necessary
2. **Workflow breakdown** — ordered phases with clear milestones and deliverables
3. **Testing strategy** — unit, integration, e2e — reference existing test patterns
4. **Dependencies** — external libs needed, internal module order/constraints
5. **Risk areas** — things that could go wrong, mitigations, known unknowns

Constraints:
- Be specific and concrete. Every statement must be actionable.
- Reference actual file names and module names from the codebase you explored.
- Aim for 3–6 paragraphs per section.
- Do NOT write implementation code in this plan — architecture and decisions only.`
  }

  private _buildSynthesisPrompt(plans: string[]): string {
    return `ULTRATHINK

You are synthesizing three competing development plans into one optimal plan.

${plans.join('\n\n---\n\n')}

## Your task
Study all three plans. Extract the best ideas from each angle:
- From **speed-first**: quick wins, minimal viable steps
- From **quality-first**: solid testing, clean error handling
- From **architecture-first**: good module boundaries, parallel workstreams

Write a single unified **Markdown plan** that:
1. Is better than any individual plan
2. Covers: Workflows, Architecture, Tests
3. Has a clear section for each: Overview, Phases, Architecture, Testing
4. Is actionable and specific — no vague statements

Output ONLY the merged plan as clean Markdown. No preamble, no meta-commentary.`
  }

  private _buildEncodePrompt(planMd: string, userRequest: string): string {
    return `ULTRATHINK

You are converting a development plan into a structured bead dependency graph.
Take significant time to carefully analyze the plan and produce a high-quality bead graph.
Think deeply about dependencies — a wrong dependency order will block the entire swarm.

## Original request
${userRequest}

## Synthesized plan
${planMd}

## Your task
Convert this plan into **50–500 self-contained work units ("beads")** with dependencies.

Output a **JSON array** of beads. Each bead must have:
\`\`\`json
{
  "id": "bead-001",
  "title": "Short imperative title (< 60 chars)",
  "description": "What exactly needs to be implemented, 1-3 sentences",
  "type": "epic|task|subtask",
  "status": "pending",
  "deps": ["bead-001"],
  "files": ["src/foo.ts", "tests/foo.test.ts"],
  "priority": 8,
  "epicId": "bead-001",
  "tags": ["backend", "api"],
  "unblockCount": 0,
  "score": 0
}
\`\`\`

Rules:
- **Hierarchy**: epics (3–8) → tasks (10–50 per epic) → subtasks (fine-grained)
- **deps**: list bead IDs that MUST be done first. A bead with no deps is ready immediately.
- **files**: realistic relative paths the bead will touch. Use empty array if unsure.
- **priority**: 1–10. Higher = more important.
- **status** is always "pending" for new beads.
- Beads must be self-contained: one agent can complete each bead independently.
- Aim for 50–200 beads total. Quality over quantity.

Output ONLY a valid JSON array. No markdown code fences, no explanation text.`
  }

  // ── JSON bead parser ───────────────────────────────────────────────────────

  private _parseAndSaveBeads(planMd: string, raw: string): number {
    // Extract JSON array from Claude's response (may have surrounding text)
    const jsonMatch = raw.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      this._log('WARN', 'No JSON array found in encode response — creating minimal graph')
      const graph = initGraph(planMd)
      saveGraph(this.ralphDir, graph)
      return 0
    }

    let parsed: unknown[]
    try {
      parsed = JSON.parse(jsonMatch[0]) as unknown[]
    } catch (e: unknown) {
      this._log('ERROR', `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`)
      const graph = initGraph(planMd)
      saveGraph(this.ralphDir, graph)
      return 0
    }

    const validStatuses = new Set(['pending', 'ready', 'claimed', 'done', 'failed'])
    const validTypes    = new Set(['epic', 'task', 'subtask'])

    const beads: Bead[] = parsed
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b, i) => ({
        id:          String(b['id']          ?? `bead-${String(i + 1).padStart(3, '0')}`),
        title:       String(b['title']       ?? 'Untitled'),
        description: String(b['description'] ?? ''),
        type:        (validTypes.has(String(b['type'])) ? b['type'] : 'task') as BeadType,
        status:      'pending' as BeadStatus,  // always start pending — we compute ready
        deps:        Array.isArray(b['deps']) ? (b['deps'] as unknown[]).map(String) : [],
        files:       Array.isArray(b['files']) ? (b['files'] as unknown[]).map(String) : [],
        priority:    typeof b['priority'] === 'number' ? Math.min(10, Math.max(1, b['priority'])) : 5,
        epicId:      b['epicId']  ? String(b['epicId'])  : undefined,
        taskId:      b['taskId']  ? String(b['taskId'])  : undefined,
        tags:        Array.isArray(b['tags']) ? (b['tags'] as unknown[]).map(String) : [],
      }))

    // Compute initial ready statuses: beads with no deps are ready immediately
    const allIds = new Set(beads.map(b => b.id))
    for (const bead of beads) {
      // Filter out deps that don't exist in the graph
      bead.deps = bead.deps.filter(d => allIds.has(d))
      if (bead.deps.length === 0) bead.status = 'ready'
    }

    const graph = initGraph(planMd)
    for (const bead of beads) upsertBead(graph, bead)
    saveGraph(this.ralphDir, graph)

    this.coordinator.post({
      from: this.agentId, type: 'info',
      text: `Bead graph created: ${beads.length} beads, ${beads.filter(b => b.status === 'ready').length} ready`
    })

    return beads.length
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private _log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', msg: string): void {
    appendFileSync(join(this.logDir, 'ralph.log'), `[${new Date().toISOString()}] [${level}] ${msg}\n`)
    this.emit('log', level, msg)
  }
}
