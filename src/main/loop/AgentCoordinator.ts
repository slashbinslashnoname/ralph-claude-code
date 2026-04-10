import * as fs from 'fs'
import * as path from 'path'
import { exec, execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
import { BdClient } from './BdClient'
import { Bead, BeadStats, FileLock, AgentInfo, ActivityEvent, KnowledgeEntry } from '../types'
import { AsyncSemaphore } from './AsyncSemaphore'
import { ProjectPaths } from './ProjectStore'
import { rotateLogFile } from './utils'

/** Write to a temp file then rename — atomic on POSIX (prevents corruption on crash). */
function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

export class AgentCoordinator {
  private lockFile: string
  private agentsFile: string
  private activityFile: string
  private knowledgeFile: string
  private _activityCache: ActivityEvent[] = []
  private _activityByBead: Map<string, ActivityEvent[]> = new Map()
  private _activityByAgent: Map<string, ActivityEvent[]> = new Map()
  private _knowledgeCache: KnowledgeEntry[] = []
  private static readonly CACHE_CAP = 1000
  private static readonly INDEX_CAP = 500
  private static readonly KNOWLEDGE_CAP = 200
  private static readonly ROTATION_SIZE = 1_048_576 // 1 MB
  private static readonly ROTATION_CHECK_INTERVAL = 50
  private _activityWriteCount = 0
  private _logWriteCount = 0
  private static readonly LOG_ROTATION_SIZE = 10_485_760 // 10 MB
  private static readonly LOG_ROTATION_MAX_FILES = 3
  private static readonly LOG_ROTATION_CHECK_INTERVAL = 50
  bd: BdClient
  planningActive = false

  private paths: ProjectPaths

  /** Simple debug logger — writes to slashbot.log if logsDir exists */
  private _log(level: string, msg: string): void {
    try {
      const logFile = path.join(this.paths.logsDir, 'slashbot.log')
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${msg}\n`)
      this._logWriteCount++
      if (this._logWriteCount >= AgentCoordinator.LOG_ROTATION_CHECK_INTERVAL) {
        this._logWriteCount = 0
        rotateLogFile(logFile, AgentCoordinator.LOG_ROTATION_SIZE, AgentCoordinator.LOG_ROTATION_MAX_FILES)
      }
    } catch { /* best-effort */ }
  }

  /** Run a git command asynchronously. Returns trimmed stdout. */
  private async _runGit(args: string[], opts?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: opts?.cwd ?? this.paths.projectRoot,
      timeout: opts?.timeout ?? 10000,
      maxBuffer: 10 * 1024 * 1024,
      env: opts?.env,
    })
    return stdout.trim()
  }

  /** Run a bd command asynchronously. Returns trimmed stdout. */
  private async _runBd(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<string> {
    const { stdout } = await execFileAsync('bd', args, {
      cwd: opts?.cwd ?? this.paths.projectRoot,
      timeout: opts?.timeout ?? 10000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout.trim()
  }

  constructor(paths: ProjectPaths) {
    this.paths = paths
    this.lockFile = paths.fileLocks
    this.agentsFile = paths.agents
    this.activityFile = paths.activity
    this.knowledgeFile = paths.knowledge
    fs.mkdirSync(paths.storeDir, { recursive: true })
    this.bd = new BdClient(paths.beadsCwd)
    this._loadActivityFromDisk()
    this._loadKnowledgeFromDisk()
  }

  /** Retry wrapper — BdClient now handles dolt restart internally, so this is a passthrough. */
  private async _bdRetry<T>(op: () => Promise<T>, _label: string): Promise<T> {
    return op()
  }

  private _loadActivityFromDisk(): void {
    if (!fs.existsSync(this.activityFile)) return
    try {
      const lines = fs
        .readFileSync(this.activityFile, 'utf8')
        .split('\n')
        .filter(Boolean)
      for (const line of lines) {
        try {
          const event: ActivityEvent = JSON.parse(line)
          this._activityCache.push(event)
          this._indexActivity(event)
        } catch { /* skip corrupt */ }
      }
      if (this._activityCache.length > AgentCoordinator.CACHE_CAP) {
        this._activityCache = this._activityCache.slice(-AgentCoordinator.CACHE_CAP)
      }
      // Cap per-key indexes
      this._capIndexes()
    } catch { /* file unreadable — start with empty cache */ }
  }

  /** Add an event to the by-bead and by-agent indexes. */
  private _indexActivity(event: ActivityEvent): void {
    if (event.beadId) {
      let list = this._activityByBead.get(event.beadId)
      if (!list) { list = []; this._activityByBead.set(event.beadId, list) }
      list.push(event)
    }
    {
      let list = this._activityByAgent.get(event.agentId)
      if (!list) { list = []; this._activityByAgent.set(event.agentId, list) }
      list.push(event)
    }
  }

  /** Enforce INDEX_CAP on all index entries. */
  private _capIndexes(): void {
    for (const [key, list] of this._activityByBead) {
      if (list.length > AgentCoordinator.INDEX_CAP) {
        this._activityByBead.set(key, list.slice(-AgentCoordinator.INDEX_CAP))
      }
    }
    for (const [key, list] of this._activityByAgent) {
      if (list.length > AgentCoordinator.INDEX_CAP) {
        this._activityByAgent.set(key, list.slice(-AgentCoordinator.INDEX_CAP))
      }
    }
  }

  // ── File locks ────────────────────────────────────────────────────────────

  readLocks(): FileLock[] {
    if (!fs.existsSync(this.lockFile)) return []
    try { return JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) } catch { return [] }
  }

  writeLocks(locks: FileLock[]): void {
    atomicWriteSync(this.lockFile, JSON.stringify(locks, null, 2))
  }

  reserveFiles(agentId: string, beadId: string, files: string[]): void {
    const locks = this.readLocks().filter(l => !(l.agentId === agentId && l.beadId === beadId))
    const now = new Date().toISOString()
    for (const file of files) {
      locks.push({ file, agentId, beadId, reservedAt: now })
    }
    this.writeLocks(locks)
  }

  releaseFiles(agentId: string, beadId: string): void {
    this.writeLocks(this.readLocks().filter(l => !(l.agentId === agentId && l.beadId === beadId)))
  }

  releaseAllForAgent(agentId: string): void {
    this.writeLocks(this.readLocks().filter(l => l.agentId !== agentId))
  }

  clearAllFileLocks(): void {
    this.writeLocks([])
  }

  lockedFilesByOthers(agentId: string): string[] {
    return this.readLocks()
      .filter(l => l.agentId !== agentId)
      .map(l => l.file)
  }

  // ── Agent registry ─────────────────────────────────────────────────────────

  readAgents(): AgentInfo[] {
    if (!fs.existsSync(this.agentsFile)) return []
    try { return JSON.parse(fs.readFileSync(this.agentsFile, 'utf8')) } catch { return [] }
  }

  writeAgents(agents: AgentInfo[]): void {
    atomicWriteSync(this.agentsFile, JSON.stringify(agents, null, 2))
  }

  registerAgent(agent: AgentInfo): void {
    const agents = this.readAgents().filter(a => a.id !== agent.id)
    agents.push(agent)
    this.writeAgents(agents)
  }

  updateAgent(id: string, patch: Partial<AgentInfo>): void {
    const agents = this.readAgents()
    const idx = agents.findIndex(a => a.id === id)
    if (idx < 0) return
    agents[idx] = { ...agents[idx], ...patch, lastActivity: new Date().toISOString() }
    this.writeAgents(agents)
  }

  deregisterAgent(id: string): void {
    this.writeAgents(this.readAgents().filter(a => a.id !== id))
    this.releaseAllForAgent(id)
  }

  getAgents(): AgentInfo[] {
    return this.readAgents()
  }

  // ── Activity log (replaces mail) ─────────────────────────────────────────

  postActivity(event: Omit<ActivityEvent, 'ts'>): void {
    const full: ActivityEvent = { ts: new Date().toISOString(), ...event } as ActivityEvent
    // Append to in-memory cache
    this._activityCache.push(full)
    if (this._activityCache.length > AgentCoordinator.CACHE_CAP) {
      this._activityCache = this._activityCache.slice(-AgentCoordinator.CACHE_CAP)
    }
    // Populate indexes
    this._indexActivity(full)
    // Cap the specific keys that were just appended to
    if (full.beadId) {
      const list = this._activityByBead.get(full.beadId)!
      if (list.length > AgentCoordinator.INDEX_CAP) {
        this._activityByBead.set(full.beadId, list.slice(-AgentCoordinator.INDEX_CAP))
      }
    }
    {
      const list = this._activityByAgent.get(full.agentId)!
      if (list.length > AgentCoordinator.INDEX_CAP) {
        this._activityByAgent.set(full.agentId, list.slice(-AgentCoordinator.INDEX_CAP))
      }
    }
    // Best-effort disk sync
    const line = JSON.stringify(full) + '\n'
    let fd: number | undefined
    try {
      fd = fs.openSync(this.activityFile, 'a') // O_WRONLY | O_APPEND | O_CREAT
      fs.writeSync(fd, line)
    } catch {
      // Activity log is best-effort; the bead DB is the source of truth.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* avoid fd leak */ }
      }
    }
    // Archive activity to dated JSONL when file exceeds 1 MB (checked every 50 writes)
    this._activityWriteCount++
    if (this._activityWriteCount >= AgentCoordinator.ROTATION_CHECK_INTERVAL) {
      this._activityWriteCount = 0
      try {
        const stat = fs.statSync(this.activityFile)
        if (stat.size > AgentCoordinator.ROTATION_SIZE) {
          const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
          const archivePath = path.join(path.dirname(this.activityFile), `activity-${date}.jsonl`)
          // Append current activity to the dated archive, then truncate
          const content = fs.readFileSync(this.activityFile, 'utf8')
          fs.appendFileSync(archivePath, content)
          fs.writeFileSync(this.activityFile, '')
        }
      } catch { /* best-effort archival */ }
    }
  }

  readActivity(limit = 50): ActivityEvent[] {
    return this._activityCache.slice(-limit)
  }

  readActivityForBead(beadId: string, limit = 100): ActivityEvent[] {
    const list = this._activityByBead.get(beadId)
    if (!list) return []
    return list.slice(-limit)
  }

  readActivityForAgent(agentId: string, limit = 100): ActivityEvent[] {
    const list = this._activityByAgent.get(agentId)
    if (!list) return []
    return list.slice(-limit)
  }

  /** List available dated archive files, newest first. */
  listActivityArchives(): string[] {
    const dir = path.dirname(this.activityFile)
    try {
      return fs.readdirSync(dir)
        .filter(f => /^activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .reverse()
    } catch { return [] }
  }

  /** Read events from archived dated JSONL files. Returns events newest-first. */
  readActivityHistory(before: string | undefined, limit: number): ActivityEvent[] {
    const archives = this.listActivityArchives()
    const results: ActivityEvent[] = []
    for (const archive of archives) {
      if (results.length >= limit) break
      const filePath = path.join(path.dirname(this.activityFile), archive)
      try {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const event: ActivityEvent = JSON.parse(lines[i])
            if (before && event.ts >= before) continue
            results.push(event)
            if (results.length >= limit) break
          } catch { /* skip corrupt */ }
        }
      } catch { /* skip unreadable */ }
    }
    return results
  }

  // ── Knowledge log ─────────────────────────────────────────────────────────

  private _loadKnowledgeFromDisk(): void {
    if (!fs.existsSync(this.knowledgeFile)) return
    try {
      const lines = fs
        .readFileSync(this.knowledgeFile, 'utf8')
        .split('\n')
        .filter(Boolean)
      for (const line of lines) {
        try { this._knowledgeCache.push(JSON.parse(line)) } catch { /* skip corrupt */ }
      }
      if (this._knowledgeCache.length > AgentCoordinator.KNOWLEDGE_CAP) {
        this._knowledgeCache = this._knowledgeCache.slice(-AgentCoordinator.KNOWLEDGE_CAP)
      }
    } catch { /* file unreadable — start with empty cache */ }
  }

  postKnowledge(entry: Omit<KnowledgeEntry, 'ts'>): void {
    const full: KnowledgeEntry = { ts: new Date().toISOString(), ...entry } as KnowledgeEntry
    // Append to in-memory cache
    this._knowledgeCache.push(full)
    if (this._knowledgeCache.length > AgentCoordinator.KNOWLEDGE_CAP) {
      this._knowledgeCache = this._knowledgeCache.slice(-AgentCoordinator.KNOWLEDGE_CAP)
    }
    // Best-effort disk sync
    const line = JSON.stringify(full) + '\n'
    let fd: number | undefined
    try {
      fd = fs.openSync(this.knowledgeFile, 'a') // O_WRONLY | O_APPEND | O_CREAT
      fs.writeSync(fd, line)
    } catch {
      // Knowledge log is best-effort; the bead DB is the source of truth.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* avoid fd leak */ }
      }
    }
  }

  readKnowledge(limit = 50): KnowledgeEntry[] {
    return this._knowledgeCache.slice(-limit)
  }

  // ── Agent heartbeats ─────────────────────────────────────────────────────

  private _heartbeats = new Map<string, number>()

  /** Record a heartbeat for the given agent (epoch ms). */
  heartbeat(agentId: string): void {
    this._heartbeats.set(agentId, Date.now())
  }

  /** Return the last heartbeat timestamp (epoch ms) for an agent, or undefined if unknown. */
  getLastHeartbeat(agentId: string): number | undefined {
    return this._heartbeats.get(agentId)
  }

  /** Remove heartbeat tracking for an agent (call on deregister). */
  clearHeartbeat(agentId: string): void {
    this._heartbeats.delete(agentId)
  }

  // ── Git worktree management ─────────────────────────────────────────────

  /** Create a git worktree for an agent's isolated work using `bd worktree create`.
   *  bd handles .beads redirect automatically — no manual symlinks needed. */
  async createWorktree(agentId: string, beadId: string): Promise<{ worktreePath: string; branch: string } | null> {
    const branch = `worker/${beadId}`
    const worktreeName = `worker-${beadId}`
    const worktreePath = path.join(this.paths.worktreesDir, worktreeName)

    try {
      // Ensure repo has at least one commit (worktrees require a valid HEAD)
      try {
        await this._runGit(['rev-parse', 'HEAD'], { timeout: 5000 })
      } catch {
        this._log('INFO', `[${agentId}] Empty git repo — creating initial commit`)
        await this._runGit(['add', '-A'], { timeout: 5000 })
        await this._runGit(['commit', '--allow-empty', '-m', 'chore: initial commit'], { timeout: 5000 })
      }

      // Clean up stale worktree if exists
      if (fs.existsSync(worktreePath)) {
        try { await this._runBd(['worktree', 'remove', worktreePath, '--force'], { timeout: 10000 }) } catch { /* ignore */ }
        try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
      }

      // Create worktree via bd — handles .beads redirect automatically
      fs.mkdirSync(this.paths.worktreesDir, { recursive: true })
      await this._runBd(
        ['worktree', 'create', worktreePath, '--branch', branch],
        { timeout: 15000 }
      )

      // Symlink .slashbot (centralized storeDir) into worktree so agent context is available
      const slashbotLink = path.join(worktreePath, '.slashbot')
      if (fs.existsSync(this.paths.storeDir) && !fs.existsSync(slashbotLink)) {
        fs.symlinkSync(this.paths.storeDir, slashbotLink, 'dir')
      }

      // Symlink .slashbotrc
      const slashbotrcSrc = this.paths.slashbotrc
      const slashbotrcLink = path.join(worktreePath, '.slashbotrc')
      if (fs.existsSync(slashbotrcSrc) && !fs.existsSync(slashbotrcLink)) {
        fs.symlinkSync(slashbotrcSrc, slashbotrcLink, 'file')
      }

      // Ensure symlinks are not committed by the agent
      const wtGitignore = path.join(worktreePath, '.gitignore')
      const ignoreEntries = ['.slashbot/', '.slashbotrc', '.worktrees/', '*.__merge_tmp/']
      if (fs.existsSync(wtGitignore)) {
        const existing = fs.readFileSync(wtGitignore, 'utf8')
        const missing = ignoreEntries.filter(e => !existing.includes(e))
        if (missing.length > 0) {
          fs.appendFileSync(wtGitignore, '\n' + missing.join('\n') + '\n')
        }
      } else {
        fs.writeFileSync(wtGitignore, ignoreEntries.join('\n') + '\n')
      }

      return { worktreePath, branch }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this._log('ERROR', `[${agentId}] Worktree creation failed for bead [${beadId}]: ${msg}`)
      return null
    }
  }

  /** Merge a worktree branch back to the current branch and clean up.
   *  Uses atomic update-ref with CAS to allow multiple worktrees to merge simultaneously.
   *  The heavy merge work happens in the agent's worktree (no global lock).
   *  Only a brief lock is held to sync the main working tree after the atomic ref update.
   *  Retries up to maxRetries times on conflict or CAS failure.
   *  If stoppedFn returns true, retries are skipped. */
  async mergeWorktree(
    agentId: string, beadId: string, branch: string, worktreePath: string,
    opts?: { maxRetries?: number; stoppedFn?: () => boolean; claudeCmd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ merged: boolean; filesChanged: string[]; error?: string; commitSha?: string }> {
    // No outer semaphore — atomic update-ref handles concurrency.
    // The mergeSemaphore is only held briefly for main working tree sync.
    return this._mergeWorktreeInner(agentId, beadId, branch, worktreePath, opts)
  }

  private async _mergeWorktreeInner(
    agentId: string, beadId: string, branch: string, worktreePath: string,
    opts?: { maxRetries?: number; stoppedFn?: () => boolean; claudeCmd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ merged: boolean; filesChanged: string[]; error?: string; commitSha?: string }> {
    const maxRetries = opts?.maxRetries ?? 2
    const stoppedFn = opts?.stoppedFn

    try {
      const baseBranch = await this._runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })

      // Verify agent branch is resolvable
      try {
        await this._runGit(['rev-parse', '--verify', branch], { timeout: 5000 })
      } catch {
        // Branch doesn't resolve — nothing to merge (brand-new worktree, no commits)
        await this._cleanupWorktree(worktreePath, branch)
        return { merged: true, filesChanged: [] }
      }

      // Check if there are any new commits on the agent branch
      const diffOutput = await this._runGit(['log', `${baseBranch}..${branch}`, '--oneline'], { timeout: 5000 })

      if (!diffOutput) {
        await this._cleanupWorktree(worktreePath, branch)
        return { merged: true, filesChanged: [] }
      }

      // Get list of files changed by the agent
      const filesOutput = await this._runGit(['diff', '--name-only', `${baseBranch}..${branch}`], { timeout: 5000 })
      const filesChanged = filesOutput ? filesOutput.split('\n').filter(Boolean) : []

      let lastError = ''

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (stoppedFn?.()) {
          await this._cleanupWorktree(worktreePath, branch)
          return { merged: false, filesChanged: [], error: 'stopped' }
        }

        // Step 1: Record current base ref for CAS (compare-and-swap)
        const oldBaseRef = await this._runGit(['rev-parse', baseBranch], { timeout: 5000 })

        // Step 2: Check if base is already an ancestor of agent branch
        let mergeNeeded = true
        try {
          await this._runGit(['merge-base', '--is-ancestor', oldBaseRef, 'HEAD'], { cwd: worktreePath, timeout: 5000 })
          mergeNeeded = false
        } catch { /* base has moved ahead — merge needed */ }

        // Step 3: Merge base into agent branch (in agent's worktree — no global lock)
        if (mergeNeeded) {
          try {
            await this._runGit(['merge', baseBranch, '--no-edit'], { cwd: worktreePath, timeout: 30000 })
          } catch (err) {
            const stderr = (err as { stderr?: Buffer | string })?.stderr
            const stdout = (err as { stdout?: Buffer | string })?.stdout
            const fullOutput = [
              err instanceof Error ? err.message : String(err),
              stderr ? String(stderr) : '',
              stdout ? String(stdout) : '',
            ].join('\n')
            lastError = fullOutput.slice(0, 2000)
            const isConflict = fullOutput.includes('CONFLICT') || fullOutput.includes('CONFLIT') || fullOutput.includes('Merge conflict')

            if (isConflict && opts?.claudeCmd) {
              const resolved = await this._resolveConflictsWithClaude(opts.claudeCmd, opts.env, worktreePath)
              if (!resolved) {
                // Claude couldn't resolve — accept agent's version for conflicted files
                try {
                  await this._runGit(['checkout', '--ours', '.'], { cwd: worktreePath, timeout: 5000 })
                  await this._runGit(['add', '-A'], { cwd: worktreePath, timeout: 5000 })
                  await this._unstageInfraFiles(worktreePath)
                  await this._runGit(['commit', '--no-edit'], { cwd: worktreePath, timeout: 10000 })
                } catch {
                  // Last resort: abort and retry
                  try { await this._runGit(['merge', '--abort'], { cwd: worktreePath, timeout: 5000 }) } catch { /* ignore */ }
                  if (attempt >= maxRetries) break
                  continue
                }
              }
              // Conflict resolved — fall through to CAS
            } else if (isConflict) {
              // No Claude available — accept agent's version for conflicted files
              try {
                await this._runGit(['checkout', '--ours', '.'], { cwd: worktreePath, timeout: 5000 })
                await this._runGit(['add', '-A'], { cwd: worktreePath, timeout: 5000 })
                await this._unstageInfraFiles(worktreePath)
                await this._runGit(['commit', '--no-edit'], { cwd: worktreePath, timeout: 10000 })
              } catch {
                try { await this._runGit(['merge', '--abort'], { cwd: worktreePath, timeout: 5000 }) } catch { /* ignore */ }
                if (attempt >= maxRetries) break
                continue
              }
              // Fall through to CAS
            } else {
              // Non-conflict merge error — retry instead of giving up
              if (attempt >= maxRetries) break
              continue
            }
          }
        }

        // Step 4: Get agent branch tip (now includes base changes)
        const newRef = await this._runGit(['rev-parse', 'HEAD'], { cwd: worktreePath, timeout: 5000 })

        // Step 5: Atomic CAS — update base branch ref to agent tip
        // Fails if another agent moved the ref since we read oldBaseRef
        try {
          await this._runGit(['update-ref', `refs/heads/${baseBranch}`, newRef, oldBaseRef], { timeout: 5000 })
        } catch {
          // CAS failed — another agent updated the base. Undo merge and retry.
          lastError = 'update-ref CAS failed (concurrent merge)'
          if (mergeNeeded) {
            try { await this._runGit(['reset', '--hard', 'HEAD~1'], { cwd: worktreePath, timeout: 5000 }) } catch { /* ignore */ }
          }
          if (attempt >= maxRetries) break
          continue
        }

        // Step 6: Sync main working tree (brief lock — only for checkout, not merge)
        await this._syncMainWorkingTree()

        await this._cleanupWorktree(worktreePath, branch)
        return { merged: true, filesChanged, commitSha: newRef }
      }

      // Exhausted retries
      await this._cleanupWorktree(worktreePath, branch)
      return { merged: false, filesChanged: [], error: lastError || 'exhausted retries' }
    } catch (err) {
      await this._cleanupWorktree(worktreePath, branch)
      return { merged: false, filesChanged: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Briefly lock and sync the main working tree to match the updated HEAD ref. */
  private async _syncMainWorkingTree(): Promise<void> {
    await this.mergeSemaphore.acquire(30000)
    try {
      // Move untracked items that might conflict with the checkout
      const movedItems = await this._moveConflictingItems()
      try {
        await this._runGit(['reset', '--hard'], { timeout: 10000 })
      } finally {
        this._restoreMovedItems(movedItems)
      }
    } finally {
      this.mergeSemaphore.release()
    }
  }

  /** Unstage infra files (.beads, .slashbot, .slashbotrc) so they don't get committed by agents. */
  private async _unstageInfraFiles(cwd?: string): Promise<void> {
    try {
      await this._runGit(['reset', 'HEAD', '--', '.beads', '.slashbot', '.slashbotrc'], { cwd, timeout: 5000 })
    } catch { /* nothing to unstage */ }
  }

  /** Move untracked symlinks/dirs (.slashbot, .beads, etc.) out of the way before checkout. */
  private async _moveConflictingItems(): Promise<Array<{ path: string; symlinkTarget?: string }>> {
    const movedItems: Array<{ path: string; symlinkTarget?: string }> = []
    // .worktrees is excluded — it contains active worktrees and renaming it
    // would break concurrent merges running in those worktrees.
    for (const name of ['.slashbot', '.slashbotrc', '.beads']) {
      const fullPath = path.join(this.paths.projectRoot, name)
      let stat: fs.Stats | null = null
      try { stat = fs.lstatSync(fullPath) } catch { continue }
      // Skip tracked files — reset --hard handles those
      try {
        await this._runGit(['ls-files', '--error-unmatch', name], { timeout: 3000 })
        continue
      } catch { /* untracked */ }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath)
        fs.unlinkSync(fullPath)
        movedItems.push({ path: fullPath, symlinkTarget: target })
      } else {
        const tmp = fullPath + '.__merge_tmp'
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ok */ }
        fs.renameSync(fullPath, tmp)
        movedItems.push({ path: fullPath })
      }
    }
    return movedItems
  }

  /** Restore previously moved untracked items. */
  private _restoreMovedItems(movedItems: Array<{ path: string; symlinkTarget?: string }>): void {
    for (const item of movedItems) {
      try {
        try { fs.rmSync(item.path, { recursive: true, force: true }) } catch { /* ok */ }
        if (item.symlinkTarget) {
          const isDir = (() => { try { return fs.statSync(item.symlinkTarget).isDirectory() } catch { return false } })()
          fs.symlinkSync(item.symlinkTarget, item.path, isDir ? 'dir' : 'file')
        } else {
          const tmp = item.path + '.__merge_tmp'
          if (fs.existsSync(tmp)) fs.renameSync(tmp, item.path)
        }
      } catch { /* ignore */ }
    }
  }

  /** Use Claude to resolve merge conflicts in the given working directory */
  private async _resolveConflictsWithClaude(claudeCmd: string, env?: NodeJS.ProcessEnv, cwd?: string): Promise<boolean> {
    const workDir = cwd ?? this.paths.projectRoot
    try {
      // Get list of conflicted files
      const conflicted = await this._runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: workDir, timeout: 5000 })

      if (!conflicted) return false

      const files = conflicted.split('\n').filter(Boolean)
      const fileList = files.join(', ')

      const prompt = `You are resolving git merge conflicts. The following files have conflicts:\n${fileList}\n\nFor each file, read it, resolve ALL conflict markers (<<<<<<< ======= >>>>>>>), keeping the best version of both sides. Then stage the resolved files with git add. Do NOT commit.`

      return new Promise<boolean>((resolve) => {
        const proc = spawn(claudeCmd, ['-p', prompt, '--dangerously-skip-permissions'], {
          cwd: workDir, env: env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let output = ''
        const timer = setTimeout(() => {
          try { proc.kill('SIGTERM') } catch { /* ignore */ }
          resolve(false)
        }, 3 * 60_000) // 3 min max for conflict resolution

        proc.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
        proc.on('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) { resolve(false); return }
          // Check if conflicts are resolved (no more conflict markers)
          this._runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: workDir, timeout: 5000 })
            .then(remaining => {
              if (remaining) { resolve(false); return }
              // Commit the merge resolution
              return this._runGit(['commit', '--no-edit'], { cwd: workDir, timeout: 10000 })
                .then(() => resolve(true))
            })
            .catch(() => resolve(false))
        })
        proc.on('error', () => { clearTimeout(timer); resolve(false) })
      })
    } catch {
      return false
    }
  }

  private async _cleanupWorktree(worktreePath: string, _branch: string): Promise<void> {
    // bd worktree remove handles git worktree + branch cleanup + beads redirect
    try { await this._runBd(['worktree', 'remove', worktreePath, '--force'], { timeout: 10000 }) } catch { /* ignore */ }
    // Force-remove directory if bd didn't clean it up
    try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  // ── Bead operations via bd CLI ─────────────────────────────────────────

  private claimSemaphore = new AsyncSemaphore()
  private commitSemaphore = new AsyncSemaphore()
  private mergeSemaphore = new AsyncSemaphore()
  private _claimTimeoutTimer: ReturnType<typeof setInterval> | null = null
  private _claimTimeoutRunning = false

  /** Expose the claim semaphore for external callers (e.g. _splitBead) that
   *  need to prevent concurrent claims while creating + claiming new beads. */
  acquireClaimLock(timeoutMs = 30_000): Promise<void> {
    return this.claimSemaphore.acquire(timeoutMs)
  }
  releaseClaimLock(): void {
    this.claimSemaphore.release()
  }

  /**
   * Diagnose and automatically unblock routing when all open beads are stuck.
   * Called by WorkerLoop after repeated consecutive routing failures.
   *
   * Handles three deadlock scenarios:
   * 1. Failed deps blocking: reopens failed deps for retry
   * 2. Complex circular deps (A→B→C→A): detects full cycles and breaks them
   * 3. Stale file locks from dead agents: clears orphaned locks
   *
   * Returns true if any corrective action was taken.
   */
  async tryUnblockRouting(agentId: string): Promise<boolean> {
    let unblocked = false
    try {
      const [openBeads, closedBeads, allBeads] = await Promise.all([
        this.bd.listByStatusAsync('open'),
        this.bd.listByStatusAsync('closed'),
        this.bd.listAllAsync(),
      ])

      if (openBeads.length === 0) return false

      const doneIds = new Set(closedBeads.filter(b => b.status === 'done').map(b => b.id))
      const failedIds = new Set(closedBeads.filter(b => b.status === 'failed').map(b => b.id))
      const epicIds = new Set(allBeads.filter(b => b.type === 'epic').map(b => b.id))
      const openChildCount = new Map<string, number>()
      for (const b of allBeads) {
        if (b.epicId && !doneIds.has(b.id) && !failedIds.has(b.id)) {
          openChildCount.set(b.epicId, (openChildCount.get(b.epicId) ?? 0) + 1)
        }
      }

      // ── 1. Reopen failed deps that block all remaining work ────────────
      const failedBlockers = new Set<string>()
      for (const bead of openBeads) {
        if (bead.type === 'epic') continue
        const realDeps = bead.deps.filter(d => d !== bead.epicId && !epicIds.has(d))
        for (const d of realDeps) {
          if (failedIds.has(d)) failedBlockers.add(d)
        }
      }
      if (failedBlockers.size > 0) {
        for (const failedId of failedBlockers) {
          try {
            await this.bd.reopenAsync(failedId, 'Auto-reopened — was blocking dependent beads')
            this.postActivity({
              agentId: 'system', type: 'info', beadId: failedId,
              summary: `Auto-reopened failed bead [${failedId}] — was blocking dependents`
            })
            this._log('WARN', `[${agentId}] auto-unblock: reopened failed dep ${failedId}`)
            unblocked = true
          } catch { /* ignore — may already be open */ }
        }
      }

      // ── 2. Detect complex circular deps (A→B→C→A) via DFS ─────────────
      // Build adjacency from open beads' unresolved deps
      const openIds = new Set(openBeads.filter(b => b.type !== 'epic').map(b => b.id))
      const adjMap = new Map<string, string[]>()
      for (const bead of openBeads) {
        if (bead.type === 'epic') continue
        const realDeps = bead.deps.filter(d => d !== bead.epicId && !epicIds.has(d))
        const blockedDeps = realDeps.filter(d => !doneIds.has(d) && openIds.has(d))
        if (blockedDeps.length > 0) adjMap.set(bead.id, blockedDeps)
      }

      // Find beads that are fully blocked (all deps unresolved AND all deps are also open+blocked)
      const fullyBlocked = new Set<string>()
      for (const bead of openBeads) {
        if (bead.type === 'epic') continue
        const realDeps = bead.deps.filter(d => d !== bead.epicId && !epicIds.has(d))
        const blockedDeps = realDeps.filter(d => !doneIds.has(d))
        const openChildren = openChildCount.get(bead.id) ?? 0
        if (blockedDeps.length > 0 || openChildren > 0) fullyBlocked.add(bead.id)
      }

      // If ALL non-epic open beads are blocked, we have a global deadlock — find a cycle to break
      const nonEpicOpen = openBeads.filter(b => b.type !== 'epic')
      if (nonEpicOpen.length > 0 && fullyBlocked.size === nonEpicOpen.length && !unblocked) {
        // DFS cycle detection
        const visited = new Set<string>()
        const inStack = new Set<string>()
        let cycleNode: string | null = null

        const dfs = (node: string): boolean => {
          visited.add(node)
          inStack.add(node)
          for (const dep of (adjMap.get(node) ?? [])) {
            if (inStack.has(dep)) { cycleNode = dep; return true }
            if (!visited.has(dep) && dfs(dep)) return true
          }
          inStack.delete(node)
          return false
        }

        for (const bead of nonEpicOpen) {
          if (!visited.has(bead.id) && dfs(bead.id)) break
        }

        if (cycleNode) {
          // Break the cycle by removing deps on the cycle node
          const cycleBead = openBeads.find(b => b.id === cycleNode)
          if (cycleBead) {
            this._log('WARN', `[${agentId}] auto-unblock: complex cycle detected — breaking at bead ${cycleNode} "${cycleBead.title}"`)
            this.postActivity({
              agentId: 'system', type: 'info', beadId: cycleNode,
              summary: `Auto-unblock: breaking dependency cycle at [${cycleNode}] "${cycleBead.title}" — deps will be ignored for this claim`
            })
            // Mark this bead as cycle-broken so claimBestBead can skip dep checks
            try {
              await this.bd.addLabelAsync(cycleNode, 'cycle_broken')
            } catch { /* ignore */ }
            unblocked = true
          }
        }
      }

      // ── 3. Clear stale file locks from dead/deregistered agents ────────
      const liveAgentIds = new Set(this.getAgents().map(a => a.id))
      const locks = this.readLocks()
      let staleLockCount = 0
      for (const lock of locks) {
        if (!liveAgentIds.has(lock.agentId)) {
          staleLockCount++
        }
      }
      if (staleLockCount > 0) {
        this._log('WARN', `[${agentId}] auto-unblock: clearing ${staleLockCount} stale file locks from dead agents`)
        this.writeLocks(locks.filter(l => liveAgentIds.has(l.agentId)))
        unblocked = true
      }

      if (unblocked) {
        this._log('INFO', `[${agentId}] auto-unblock: corrective action taken — routing should resume`)
      } else {
        this._log('INFO', `[${agentId}] auto-unblock: no corrective action available — all beads genuinely blocked`)
      }

    } catch (err) {
      this._log('ERROR', `[${agentId}] tryUnblockRouting failed: ${err instanceof Error ? err.message : err}`)
    }
    return unblocked
  }

  /**
   * Start a background sweep that periodically reopens beads stuck in_progress
   * past 2× claudeTimeoutMinutes when the owning agent has no live heartbeat.
   * Runs outside the claimSemaphore to avoid blocking claim operations.
   */
  startClaimTimeoutSweep(claudeTimeoutMinutes: number, intervalMs = 60_000): void {
    this.stopClaimTimeoutSweep()
    this._claimTimeoutTimer = setInterval(() => {
      this._runClaimTimeoutSweep(claudeTimeoutMinutes)
    }, intervalMs)
    // Also run once immediately (fire-and-forget)
    this._runClaimTimeoutSweep(claudeTimeoutMinutes)
  }

  stopClaimTimeoutSweep(): void {
    if (this._claimTimeoutTimer) {
      clearInterval(this._claimTimeoutTimer)
      this._claimTimeoutTimer = null
    }
  }

  private async _runClaimTimeoutSweep(claudeTimeoutMinutes: number): Promise<void> {
    if (this._claimTimeoutRunning) return // prevent overlapping sweeps
    this._claimTimeoutRunning = true
    try {
      await this._checkClaimTimeouts(claudeTimeoutMinutes)
    } catch { /* non-fatal */ }
    finally { this._claimTimeoutRunning = false }
  }

  /**
   * Reopen beads stuck in_progress past 2× claudeTimeoutMinutes when the
   * owning agent has no live heartbeat.
   */
  private async _checkClaimTimeouts(claudeTimeoutMinutes: number): Promise<void> {
    const thresholdMs = 2 * claudeTimeoutMinutes * 60_000
    const now = Date.now()
    const inProgress = await this.bd.listByStatusAsync('in_progress')

    for (const bead of inProgress) {
      // Determine which agent owns this bead from activity events
      const beadAgent = bead.claimedBy
      if (!beadAgent) continue

      // Find last activity event for this agent
      const agentEvents = this._activityByAgent.get(beadAgent)
      if (!agentEvents || agentEvents.length === 0) continue

      const lastEvent = agentEvents[agentEvents.length - 1]
      const lastEventAge = now - new Date(lastEvent.ts).getTime()

      if (lastEventAge <= thresholdMs) continue

      // Check if agent has a live heartbeat
      const lastHeartbeat = this.getLastHeartbeat(beadAgent)
      if (lastHeartbeat !== undefined && (now - lastHeartbeat) <= thresholdMs) continue

      // Timed out and no live heartbeat — reopen
      await this.bd.reopenAsync(bead.id, `Timed out — agent ${beadAgent} unresponsive`)
      this.releaseFiles(beadAgent, bead.id)
      this.postActivity({
        agentId: 'system',
        type: 'claim_timeout',
        beadId: bead.id,
        beadTitle: bead.title,
        summary: `Reopened bead [${bead.id}] — agent ${beadAgent} timed out (${Math.round(lastEventAge / 60_000)}m since last activity)`
      })
    }
  }

  async claimBestBead(agentId: string, claudeTimeoutMinutes = 15): Promise<Bead | null> {
    await this.claimSemaphore.acquire(30_000)

    try {
      // ── Purge stale agents + orphaned file locks ─────────────────────
      // Agents that no longer have a heartbeat and haven't sent activity
      // in a long time are likely dead — deregister them so their file locks
      // and claimedBy fields don't block beads.
      const now = Date.now()
      const staleThresholdMs = 5 * 60_000 // 5 minutes
      const registeredAgents = this.getAgents()
      for (const agent of registeredAgents) {
        if (agent.id === agentId) continue
        const hb = this.getLastHeartbeat(agent.id)
        const lastAct = agent.lastActivity ? new Date(agent.lastActivity).getTime() : 0
        const mostRecent = Math.max(hb ?? 0, lastAct)
        // Only deregister if both heartbeat and lastActivity are stale
        if (mostRecent > 0 && (now - mostRecent) > staleThresholdMs) {
          this._log('WARN', `[${agentId}] Deregistering stale agent ${agent.id} (last seen ${Math.round((now - mostRecent) / 1000)}s ago)`)
          this.deregisterAgent(agent.id)
        }
      }

      const lockedFiles = new Set(this.lockedFilesByOthers(agentId))

      // Get ALL open beads as candidates — we handle dep filtering ourselves.
      // bd ready is too strict (blocks beads with in_progress deps that we allow).
      let candidates: Bead[]
      let closedBeads: Bead[]
      let allBeads: Bead[]
      try {
        ;[candidates, closedBeads, allBeads] = await this._bdRetry(
          () => Promise.all([
            this.bd.listByStatusAsync('open'),
            this.bd.listByStatusAsync('closed'),
            this.bd.listAllAsync(),
          ]),
          `[${agentId}] claimBestBead:list`
        )
      } catch (err) {
        this._log('ERROR', `[${agentId}] claimBestBead: bd list failed: ${err instanceof Error ? err.message : err}`)
        return null
      }

      // If bd returned empty for all lists, it's likely a bd CLI failure, not "no beads"
      if (candidates.length === 0 && closedBeads.length === 0 && allBeads.length === 0) {
        this._log('WARN', `[${agentId}] claimBestBead: bd returned empty for ALL lists — possible bd CLI issue`)
      }

      // Separate successfully-done from failed beads — failed deps should NOT unblock dependents
      const doneIds = new Set(closedBeads.filter(b => b.status === 'done').map(b => b.id))
      const failedIds = new Set(closedBeads.filter(b => b.status === 'failed').map(b => b.id))
      const openChildCount = new Map<string, number>()
      for (const b of allBeads) {
        if (b.epicId && !doneIds.has(b.id) && !failedIds.has(b.id)) {
          openChildCount.set(b.epicId, (openChildCount.get(b.epicId) ?? 0) + 1)
        }
      }

      // Read retry attempts from labels to deprioritize beads that keep failing
      const retryCount = new Map<string, number>()
      for (const c of candidates) {
        const tag = c.tags.find(t => t.startsWith('retry_attempt:'))
        if (tag) {
          const n = parseInt(tag.split(':')[1], 10)
          if (!isNaN(n) && n > 0) retryCount.set(c.id, n)
        }
      }

      // ── Epic convergence: prefer beads in epics closest to completion ───
      const epicTotal = new Map<string, number>()
      const epicRemaining = new Map<string, number>()
      const epicHasActiveAgent = new Set<string>()

      for (const b of allBeads) {
        if (b.epicId && b.type !== 'epic') {
          epicTotal.set(b.epicId, (epicTotal.get(b.epicId) ?? 0) + 1)
          if (!doneIds.has(b.id)) {
            epicRemaining.set(b.epicId, (epicRemaining.get(b.epicId) ?? 0) + 1)
          }
        }
      }

      // Detect which epics have a peer agent currently working in them
      for (const agent of this.getAgents()) {
        if (agent.id !== agentId && agent.currentBeadId) {
          const agentBead = allBeads.find(b => b.id === agent.currentBeadId)
          if (agentBead?.epicId) epicHasActiveAgent.add(agentBead.epicId)
        }
      }

      // Track in_progress beads — used for logging, NOT for unblocking deps.
      // Only done deps unblock dependents. Agents wait for deps to finish.
      const inProgressIds = new Set(allBeads.filter(b => b.status === 'claimed').map(b => b.id))

      // Build set of epic IDs — used to exclude parent-child deps from blocking checks
      const epicIds = new Set(allBeads.filter(b => b.type === 'epic').map(b => b.id))

      // Sort: retries → unresolved deps → priority → epic convergence → FIFO → ID
      candidates.sort((a, b) => {
        const retriesA = retryCount.get(a.id) ?? 0
        const retriesB = retryCount.get(b.id) ?? 0
        if (retriesA !== retriesB) return retriesA - retriesB
        // Count blocked deps — only done deps unblock. Agents wait for in_progress deps to finish.
        // Failed deps count as blocked. Exclude epic parent deps (containment, not work deps).
        const depsA = a.deps.filter(d => d !== a.epicId && !epicIds.has(d))
        const depsB = b.deps.filter(d => d !== b.epicId && !epicIds.has(d))
        const blockedA = depsA.filter(d => !doneIds.has(d)).length + (openChildCount.get(a.id) ?? 0)
        const blockedB = depsB.filter(d => !doneIds.has(d)).length + (openChildCount.get(b.id) ?? 0)
        if (blockedA !== blockedB) return blockedA - blockedB
        const priDiff = (a.priority ?? 2) - (b.priority ?? 2)
        if (priDiff !== 0) return priDiff

        // Epic convergence: prefer beads in epics closest to completion
        // Score = remaining/total (lower = closer to done). Orphans score 2.0.
        const epicScoreA = a.epicId
          ? (epicRemaining.get(a.epicId) ?? 1) / (epicTotal.get(a.epicId) ?? 1)
          : 2.0
        const epicScoreB = b.epicId
          ? (epicRemaining.get(b.epicId) ?? 1) / (epicTotal.get(b.epicId) ?? 1)
          : 2.0
        // Peer attraction: slight bonus if another agent is already in this epic
        const peerBonusA = (a.epicId && epicHasActiveAgent.has(a.epicId)) ? -0.1 : 0
        const peerBonusB = (b.epicId && epicHasActiveAgent.has(b.epicId)) ? -0.1 : 0
        const convergenceDiff = (epicScoreA + peerBonusA) - (epicScoreB + peerBonusB)
        if (Math.abs(convergenceDiff) > 0.001) return convergenceDiff > 0 ? 1 : -1

        // FIFO tiebreaker: earliest createdAt first (undefined sorts last)
        const ca = a.createdAt
        const cb = b.createdAt
        if (ca !== cb) {
          if (!ca) return 1
          if (!cb) return -1
          if (ca < cb) return -1
          if (ca > cb) return 1
        }
        // Final fallback: numeric ID ascending, then localeCompare for non-numeric
        const na = Number(a.id)
        const nb = Number(b.id)
        if (!isNaN(na) && !isNaN(nb)) return na - nb
        return a.id.localeCompare(b.id)
      })

      this._log('INFO', `[${agentId}] claimBestBead: ${candidates.length} candidates, ${closedBeads.length} done, ${inProgressIds.size} in_progress, ${lockedFiles.size} locked files, ${epicIds.size} epics`)
      if (candidates.length > 0) {
        this._log('INFO', `[${agentId}] candidates: ${candidates.map(b => `${b.id}(type=${b.type},deps=[${b.deps.join(',')}],epicId=${b.epicId ?? 'none'},claimedBy=${b.claimedBy ?? 'none'})`).join(', ')}`)
      }

      for (const bead of candidates) {
        // Never pick up epics — they are containers, not work items.
        if (bead.type === 'epic') {
          this._log('INFO', `[${agentId}] skip ${bead.id}: type is epic (container, not work item)`)
          continue
        }

        // Skip beads whose dependencies are not yet done.
        // Only done deps unblock — agents wait for in_progress deps to finish.
        // Failed deps are treated as unresolved — the dependent bead shouldn't proceed.
        // Exclude parent-child deps from blocking checks — parent-child is a containment
        // relationship, not a work dependency. bd sometimes includes it in the flat deps array.
        // Exception: beads with 'cycle_broken' label bypass dep checks (set by tryUnblockRouting).
        const isCycleBroken = bead.tags.includes('cycle_broken')
        const realDeps = bead.deps.filter(d => d !== bead.epicId && !epicIds.has(d))
        const blockedDeps = realDeps.filter(d => !doneIds.has(d))
        const failedDeps = realDeps.filter(d => failedIds.has(d))
        const openChildren = openChildCount.get(bead.id) ?? 0
        if (isCycleBroken) {
          this._log('WARN', `[${agentId}] ${bead.id}: cycle_broken label — bypassing dep checks`)
          // Remove the label so it's a one-shot override
          this.bd.removeLabelAsync(bead.id, 'cycle_broken').catch(() => {})
        } else if (failedDeps.length > 0) {
          this._log('INFO', `[${agentId}] skip ${bead.id}: ${failedDeps.length} failed deps [${failedDeps.join(',')}]`)
          continue
        }
        if (!isCycleBroken && (blockedDeps.length > 0 || openChildren > 0)) {
          // Detect circular deps: if ALL blocked deps also depend on this bead, it's a cycle — break it
          const isCircular = blockedDeps.length > 0 && openChildren === 0 && blockedDeps.every(depId => {
            const depBead = candidates.find(c => c.id === depId) ?? allBeads.find(b => b.id === depId)
            return depBead?.deps.includes(bead.id)
          })
          if (isCircular) {
            this._log('WARN', `[${agentId}] ${bead.id}: circular dependency detected with [${blockedDeps.join(',')}] — breaking cycle`)
            // Fall through and allow claiming this bead to break the deadlock
          } else {
            const waitingOn = blockedDeps.filter(d => inProgressIds.has(d))
            const notStarted = blockedDeps.filter(d => !inProgressIds.has(d))
            this._log('INFO', `[${agentId}] skip ${bead.id}: ${blockedDeps.length} blocked deps — waiting on in_progress: [${waitingOn.join(',')}], not started: [${notStarted.join(',')}], ${openChildren} open children`)
            continue
          }
        }

        if (bead.files.some(f => lockedFiles.has(f))) {
          this._log('INFO', `[${agentId}] skip ${bead.id}: file locked by another agent`)
          continue
        }

        // Skip if actively claimed by another LIVE agent (check agent registry, not just claimedBy field)
        if (bead.claimedBy && bead.claimedBy !== agentId) {
          const liveAgents = this.getAgents().map(a => a.id)
          if (liveAgents.includes(bead.claimedBy)) {
            this._log('INFO', `[${agentId}] skip ${bead.id}: claimed by live agent ${bead.claimedBy}`)
            continue
          }
          this._log('INFO', `[${agentId}] ${bead.id}: stale claim by ${bead.claimedBy} (not in live agents), attempting takeover`)
        }

        // Skip if any live agent is actively working on this bead (in-memory check).
        const activeAgent = this.getAgents().find(a => a.id !== agentId && a.currentBeadId === bead.id)
        if (activeAgent) {
          this._log('INFO', `[${agentId}] skip ${bead.id}: agent ${activeAgent.id} has currentBeadId=${bead.id}`)
          continue
        }

        // Assign directly to this agent.
        // If the bead has a stale claimedBy from a previous session, unclaim first so bd
        // doesn't reject the --claim with "already claimed".
        this._log('INFO', `[${agentId}] attempting to claim ${bead.id} "${bead.title}"…`)
        if (bead.claimedBy) {
          this._log('INFO', `[${agentId}] ${bead.id} has stale claimedBy=${bead.claimedBy}, unclaiming first`)
          try { await this.bd.runPublicAsync(['update', bead.id, '--assignee', '', '--json']) }
          catch { try { this.bd.runPublic(['update', bead.id, '--assignee', '', '--json']) } catch { /* ignore */ } }
        }
        let assigned = false
        try {
          assigned = await this.bd.assignToAsync(bead.id, agentId)
        } catch (err) {
          // Async failed — try sync fallback
          this._log('WARN', `[${agentId}] assignToAsync failed for ${bead.id}: ${err instanceof Error ? err.message : err} — trying sync fallback`)
          try { assigned = this.bd.assignTo(bead.id, agentId) }
          catch (err2) { this._log('ERROR', `[${agentId}] assignTo sync also failed for ${bead.id}: ${err2 instanceof Error ? err2.message : err2}`) }
        }
        if (!assigned) {
          this._log('WARN', `[${agentId}] skip ${bead.id}: assignTo failed`)
          continue
        }

        this.reserveFiles(agentId, bead.id, bead.files)
        this.postActivity({ agentId, type: 'claimed', beadId: bead.id, beadTitle: bead.title, summary: `Claimed bead [${bead.id}] ${bead.title}` })
        // Preserve original title — bd show may return a corrupted title after set-state
        const originalTitle = bead.title
        let freshBead: Bead | null = null
        try { freshBead = await this.bd.showAsync(bead.id) }
        catch { /* showAsync failed — use in-memory bead data */ }
        const result = freshBead ?? { ...bead, status: 'claimed', claimedBy: agentId }
        if (originalTitle && result.title !== originalTitle) {
          result.title = originalTitle
        }
        return result
      }
      this._log('WARN', `[${agentId}] claimBestBead: all ${candidates.length} candidates were skipped — no suitable bead found`)
      return null
    } finally {
      this.claimSemaphore.release()
    }
  }

  async completeBead(agentId: string, beadId: string, filesChanged?: string[], autoPush = true): Promise<void> {
    // Idempotency: skip if bead is already done
    try {
      const current = await this.bd.showAsync(beadId)
      if (current?.status === 'done') {
        this.releaseFiles(agentId, beadId)
        this.postActivity({ agentId, type: 'completed', beadId, filesChanged, summary: `Completed [${beadId}] (already done)` })
        return
      }
    } catch { /* bead not found — proceed and let bd.close handle the error */ }

    // Commit and push first so we can capture the SHA — if this fails,
    // the bead stays in_progress and work is not silently lost.
    // releaseFiles runs in finally so locks are never left stuck.
    let commitSha: string | null
    try {
      commitSha = await this.commitAndPush(agentId, beadId, autoPush)
    } finally {
      this.releaseFiles(agentId, beadId)
    }

    try {
      await this._bdRetry(() => this.bd.closeAsync(beadId, `Completed by ${agentId}`), `completeBead(${beadId})`)
    } catch (err) {
      // bd close can fail for epics with open children — don't crash the worker
      const msg = err instanceof Error ? err.message : String(err)
      this.postActivity({ agentId, type: 'info', beadId, summary: `Close failed (non-fatal): ${msg.slice(0, 120)}` })
    }

    this.postActivity({ agentId, type: 'completed', beadId, filesChanged, commitSha: commitSha ?? undefined, summary: `Completed [${beadId}]${filesChanged?.length ? ` — ${filesChanged.length} files` : ''}` })

    // Auto-close parent epic if all siblings are done
    await this._maybeCloseEpic(agentId, beadId)
  }

  /**
   * If the completed bead has a parent epic, check whether all siblings under
   * that epic are now done. If so, close the epic automatically.
   * Leverages idempotent close — a spurious double-close is harmless.
   */
  private async _maybeCloseEpic(agentId: string, beadId: string): Promise<void> {
    try {
      const bead = await this.bd.showAsync(beadId)
      if (!bead?.epicId) return

      const epicId = bead.epicId
      const epic = await this.bd.showAsync(epicId)
      if (!epic || epic.status === 'done') return // already closed or missing

      const allBeads = await this.bd.listAllAsync()
      const siblings = allBeads.filter(b => b.epicId === epicId && b.id !== epicId)
      if (siblings.length === 0) return

      const allDone = siblings.every(b => b.status === 'done')
      if (!allDone) return

      await this._bdRetry(() => this.bd.closeAsync(epicId, `All children completed — auto-closed by ${agentId}`), `autoCloseEpic(${epicId})`)
      this.postActivity({
        agentId,
        type: 'completed',
        beadId: epicId,
        beadTitle: epic.title,
        summary: `Auto-closed epic [${epicId}] — all children done`
      })
    } catch {
      // Non-fatal — epic auto-close is best-effort
    }
  }

  /** Commit any pending changes and push to remote. Returns the commit SHA or null. */
  async commitAndPush(agentId: string, beadId: string, autoPush = true): Promise<string | null> {
    await this.commitSemaphore.acquire(60000)
    try {
      // Stage everything (merged code) but exclude infra symlinks
      await this._runGit(['add', '-A'], { timeout: 10000 })
      await this._unstageInfraFiles()

      // Check if there's anything to commit
      try {
        await this._runGit(['diff', '--cached', '--quiet'], { timeout: 5000 })
        return null // nothing staged
      } catch { /* has staged changes — continue */ }

      // Commit
      const msg = `feat: complete bead ${beadId} [${agentId}]`
      await this._runGit(['commit', '-m', msg], {
        timeout: 10000,
        env: { ...process.env, GIT_AUTHOR_NAME: agentId, GIT_COMMITTER_NAME: agentId }
      })

      // Capture the commit SHA
      let commitSha: string | null = null
      try {
        commitSha = await this._runGit(['rev-parse', 'HEAD'], { timeout: 5000 })
      } catch { /* non-fatal — SHA capture failed */ }

      // Push to remote (current branch)
      if (autoPush) {
        try {
          const branch = await this._runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })
          await this._runGit(['push', 'origin', branch], { timeout: 30000 })
        } catch (err) {
          // Push may fail if no remote or no upstream — non-fatal
          const msg = err instanceof Error ? err.message : String(err)
          this.postActivity({ agentId, type: 'info', summary: `Push failed (non-fatal): ${msg.slice(0, 100)}` })
        }
      }

      return commitSha
    } finally {
      this.commitSemaphore.release()
    }
  }

  async reopenBead(agentId: string, beadId: string): Promise<void> {
    // Idempotency: skip if bead is already open
    try {
      const current = await this.bd.showAsync(beadId)
      if (current?.status === 'ready') {
        this.releaseFiles(agentId, beadId)
        return
      }
    } catch { /* bead not found — proceed and let bd.reopen handle the error */ }

    await this.bd.reopenAsync(beadId, `Reopened by ${agentId} for retry`)
    this.releaseFiles(agentId, beadId)
  }

  /** Remove all per-worker circuit breaker state files so workers start fresh. */
  private _resetCircuitBreakers(): void {
    try {
      const files = fs.readdirSync(this.paths.storeDir)
        .filter(f => f.startsWith('.circuit_breaker_state_'))
      for (const file of files) {
        try { fs.unlinkSync(path.join(this.paths.storeDir, file)) } catch { /* ignore */ }
      }
    } catch { /* ignore — storeDir may not exist yet */ }
  }

  /** Reopen any beads left in claimed/in_progress from a previous session */
  async reopenStaleBeads(): Promise<void> {
    const claimed = await this.bd.listByStatusAsync('in_progress')
    for (const bead of claimed) {
      try {
        await this.bd.reopenAsync(bead.id, 'Reopened on startup — stale from previous session')
        this.postActivity({ agentId: 'system', type: 'info', beadId: bead.id, beadTitle: bead.title, summary: `Reopened stale bead [${bead.id}]` })
      } catch { /* ignore — may already be open */ }
    }
    // Also clear stale claimedBy on open beads — bd keeps the assignee even after
    // reopen, and bd update --claim rejects "already claimed" if assignee is set.
    try {
      const openBeads = await this.bd.listByStatusAsync('open')
      for (const bead of openBeads) {
        if (bead.claimedBy) {
          try {
            await this.bd.runPublicAsync(['update', bead.id, '--assignee', '', '--json'])
            this._log('INFO', `Cleared stale claim on open bead [${bead.id}] (was: ${bead.claimedBy})`)
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore — best effort */ }
    // Clear all file locks from previous session
    this.clearAllFileLocks()
    // Reset circuit breaker state from previous session so workers start clean
    this._resetCircuitBreakers()
    // Clean up orphaned worktrees from previous session
    await this.cleanOrphanedWorktrees()
    // Prune stale git worktree references
    try { await this._runGit(['worktree', 'prune'], { timeout: 5000 }) } catch { /* ignore */ }
  }

  /** Alias — kept for backward compatibility; reopenStaleBeads is now async. */
  async reopenStaleBeadsAsync(): Promise<void> {
    return this.reopenStaleBeads()
  }

  /**
   * Rollback a bead by reverting its commits in reverse chronological order.
   * Reads commit SHAs from the activity cache, filters to only the last successful
   * merged+completed pair (ignoring events before a failed/reopened event),
   * deduplicates, reverts via git revert --no-edit, aborts on conflict,
   * reopens the bead, and posts a rollback activity event.
   */
  async rollbackBead(agentId: string, beadId: string): Promise<{ reverted: boolean; revertedShas: string[]; error?: string }> {
    // Collect activity events for this bead (indexed lookup)
    const beadEvents = this._activityByBead.get(beadId) ?? []

    // Find the index of the last failed/reopened event — we only care about events after it
    let cutoffIdx = -1
    for (let i = beadEvents.length - 1; i >= 0; i--) {
      if (beadEvents[i].type === 'failed' || beadEvents[i].type === 'rollback') {
        cutoffIdx = i
        break
      }
    }
    const relevantEvents = cutoffIdx >= 0 ? beadEvents.slice(cutoffIdx + 1) : beadEvents

    // Extract commit SHAs from the last merged+completed pair
    const shas: string[] = []
    for (const ev of relevantEvents) {
      if ((ev.type === 'merged' || ev.type === 'completed') && ev.commitSha) {
        shas.push(ev.commitSha)
      }
    }

    // Deduplicate while preserving order
    const uniqueShas = [...new Set(shas)]

    if (uniqueShas.length === 0) {
      return { reverted: false, revertedShas: [], error: 'No commit SHAs found in activity cache for this bead' }
    }

    // Revert in reverse chronological order (latest first)
    const reversedShas = [...uniqueShas].reverse()
    const revertedShas: string[] = []

    for (const sha of reversedShas) {
      try {
        await this._runGit(['revert', '--no-edit', sha], { timeout: 15000 })
        revertedShas.push(sha)
      } catch (err) {
        // Conflict during revert — abort and return error
        try {
          await this._runGit(['revert', '--abort'], { timeout: 5000 })
        } catch { /* ignore — abort may fail if no revert in progress */ }
        const msg = err instanceof Error ? err.message : String(err)
        this.releaseFiles(agentId, beadId)
        this.postActivity({
          agentId, type: 'rollback', beadId,
          summary: `Rollback failed for [${beadId}]: conflict reverting ${sha} — ${msg.slice(0, 100)}`
        })
        return { reverted: false, revertedShas, error: `Conflict reverting ${sha}: ${msg.slice(0, 200)}` }
      }
    }

    // Reopen the bead via bd CLI
    try {
      await this.bd.reopenAsync(beadId, `Rolled back by ${agentId}`)
    } catch (err) {
      // Non-fatal — bead may already be open
      const msg = err instanceof Error ? err.message : String(err)
      this.postActivity({ agentId, type: 'rollback', beadId, summary: `Reopen after rollback failed (non-fatal): ${msg.slice(0, 100)}` })
    }

    // Release file locks
    this.releaseFiles(agentId, beadId)

    // Post rollback activity event
    this.postActivity({
      agentId, type: 'rollback', beadId,
      summary: `Rolled back [${beadId}] — reverted ${revertedShas.length} commit(s)`,
      commitSha: revertedShas[0]
    })

    return { reverted: true, revertedShas }
  }

  async failBead(agentId: string, beadId: string, reason: string): Promise<void> {
    // Idempotency: skip if bead is already failed
    try {
      const current = await this.bd.showAsync(beadId)
      if (current?.status === 'failed') {
        this.releaseFiles(agentId, beadId)
        this.postActivity({ agentId, type: 'failed', beadId, summary: `${reason} (already failed)` })
        return
      }
    } catch { /* bead not found — proceed and let bd.close handle the error */ }

    await this._bdRetry(() => this.bd.addLabelAsync(beadId, 'failed'), `failBead:label(${beadId})`)
    await this._bdRetry(() => this.bd.closeAsync(beadId, `Failed: ${reason}`), `failBead:close(${beadId})`)
    this.releaseFiles(agentId, beadId)
    this.postActivity({ agentId, type: 'failed', beadId, summary: reason })
  }

  /** Remove worktree directories not owned by any registered agent. */
  async cleanOrphanedWorktrees(): Promise<string[]> {
    const worktreesDir = this.paths.worktreesDir
    if (!fs.existsSync(worktreesDir)) return []

    const activeAgents = this.readAgents()
    const agents = new Set(activeAgents.map(a => a.id))
    const activeBranches = new Set(activeAgents.map(a => a.worktreeBranch).filter(Boolean))
    const removed: string[] = []

    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(worktreesDir, { withFileTypes: true }) } catch { return [] }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const wtPath = path.join(worktreesDir, entry.name)
      let branch: string | null = null

      // New pattern: worker-<beadId>, e.g. "worker-sb-abc"
      if (entry.name.startsWith('worker-')) {
        const beadId = entry.name.slice('worker-'.length)
        branch = `worker/${beadId}`
        if (activeBranches.has(branch)) continue
      } else {
        // Legacy pattern: agent-N-<beadId>, e.g. "agent-0-sb-abc"
        const legacyMatch = entry.name.match(/^(agent-\d+)-(.+)$/)
        if (legacyMatch) {
          const agentId = legacyMatch[1]
          if (agents.has(agentId)) continue // owned by active agent
          branch = `agent/${agentId}/${legacyMatch[2]}`
        } else {
          // Unknown format — still clean up the directory
        }
      }

      if (branch) {
        await this._cleanupWorktree(wtPath, branch)
      }
      // Fallback: rm dir if git worktree remove didn't work
      try { if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true }) } catch { /* ignore */ }
      removed.push(entry.name)
    }
    return removed
  }

  async hasOpenWork(): Promise<boolean> {
    if (this.planningActive) return true
    const open = await this.bd.listByStatusAsync('open')
    if (open.length > 0) return true
    const inProgress = await this.bd.listByStatusAsync('in_progress')
    return inProgress.length > 0
  }

  /** Alias — kept for backward compatibility; hasOpenWork is now async. */
  async hasOpenWorkAsync(): Promise<boolean> {
    return this.hasOpenWork()
  }

  async getStats(): Promise<BeadStats> {
    return this.bd.statsAsync()
  }

  /** Alias — kept for backward compatibility; getStats is now async. */
  async getStatsAsync(): Promise<BeadStats> {
    return this.getStats()
  }
}
