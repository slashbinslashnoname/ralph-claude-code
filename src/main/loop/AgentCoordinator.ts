import * as fs from 'fs'
import * as path from 'path'
import { execSync, spawn } from 'child_process'
import { BdClient } from './BdClient'
import { Bead, BeadStats, FileLock, AgentInfo, ActivityEvent, KnowledgeEntry, MailMessage } from '../types'
import { AsyncSemaphore } from './AsyncSemaphore'
import { ProjectPaths } from './ProjectStore'

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
  private _mailCache: MailMessage[] = []
  private _mailByAgent: Map<string, MailMessage[]> = new Map()
  private _mailWatcher: ReturnType<typeof import('chokidar').watch> | null = null
  private _mailFileSize = 0
  private mailFile: string
  private static readonly CACHE_CAP = 1000
  private static readonly KNOWLEDGE_CAP = 200
  private static readonly MAIL_CAP = 500
  private static readonly INDEX_CAP = 500
  private static readonly ROTATION_SIZE = 1_048_576 // 1 MB
  private static readonly ROTATION_CHECK_INTERVAL = 50
  private _activityWriteCount = 0
  bd: BdClient
  planningActive = false

  private paths: ProjectPaths

  /** Simple debug logger — writes to slashbot.log if logsDir exists */
  private _log(level: string, msg: string): void {
    try {
      const logFile = path.join(this.paths.logsDir, 'slashbot.log')
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${msg}\n`)
    } catch { /* best-effort */ }
  }

  constructor(paths: ProjectPaths) {
    this.paths = paths
    this.lockFile = paths.fileLocks
    this.agentsFile = paths.agents
    this.activityFile = paths.activity
    this.knowledgeFile = paths.knowledge
    this.mailFile = paths.mail
    fs.mkdirSync(paths.storeDir, { recursive: true })
    this.bd = new BdClient(paths.projectRoot)
    this._loadActivityFromDisk()
    this._loadKnowledgeFromDisk()
    this._loadMailFromDisk()
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
    // Rotate activity log when it exceeds 1 MB (checked every 50 writes)
    this._activityWriteCount++
    if (this._activityWriteCount >= AgentCoordinator.ROTATION_CHECK_INTERVAL) {
      this._activityWriteCount = 0
      try {
        const stat = fs.statSync(this.activityFile)
        if (stat.size > AgentCoordinator.ROTATION_SIZE) {
          fs.renameSync(this.activityFile, this.activityFile + '.1')
        }
      } catch { /* best-effort rotation */ }
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

  // ── Mail (inter-agent messages from mail.jsonl) ─────────────────────────

  private _loadMailFromDisk(): void {
    if (!fs.existsSync(this.mailFile)) return
    try {
      const content = fs.readFileSync(this.mailFile, 'utf8')
      this._mailFileSize = Buffer.byteLength(content, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const msg: MailMessage = JSON.parse(line)
          this._mailCache.push(msg)
          this._indexMail(msg)
        } catch { /* skip corrupt */ }
      }
      if (this._mailCache.length > AgentCoordinator.MAIL_CAP) {
        this._mailCache = this._mailCache.slice(-AgentCoordinator.MAIL_CAP)
      }
      this._capMailIndexes()
    } catch { /* file unreadable — start with empty cache */ }
  }

  private _capMailIndexes(): void {
    for (const [key, list] of this._mailByAgent) {
      if (list.length > AgentCoordinator.INDEX_CAP) {
        this._mailByAgent.set(key, list.slice(-AgentCoordinator.INDEX_CAP))
      }
    }
  }

  private _indexMail(msg: MailMessage): void {
    // Index by 'to' agent
    let toList = this._mailByAgent.get(msg.to)
    if (!toList) { toList = []; this._mailByAgent.set(msg.to, toList) }
    toList.push(msg)
    // Also index by 'from' agent
    if (msg.from !== msg.to) {
      let fromList = this._mailByAgent.get(msg.from)
      if (!fromList) { fromList = []; this._mailByAgent.set(msg.from, fromList) }
      fromList.push(msg)
    }
  }

  readMail(limit = 50): MailMessage[] {
    return this._mailCache.slice(-limit)
  }

  readMailForAgent(agentId: string, limit = 100): MailMessage[] {
    const list = this._mailByAgent.get(agentId)
    if (!list) return []
    return list.slice(-limit)
  }

  /**
   * Watch mail.jsonl for new messages via chokidar.
   * Tracks file size delta and only parses/emits newly appended lines.
   */
  watchMail(cb: (messages: MailMessage[]) => void): void {
    if (this._mailWatcher) return // already watching

    // Lazy-import chokidar to avoid pulling it in when not needed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chokidar = require('chokidar')

    const mailBasename = path.basename(this.mailFile)
    const mailDir = path.dirname(this.mailFile)

    this._mailWatcher = chokidar.watch(mailDir, {
      persistent: true,
      ignoreInitial: true,
      usePolling: false,
      depth: 0,
    })

    const onFileEvent = (filePath: string): void => {
      if (path.basename(filePath) !== mailBasename) return
      this._readNewMailLines(cb)
    }

    this._mailWatcher!.on('change', onFileEvent)
    this._mailWatcher!.on('add', onFileEvent)
  }

  private _readNewMailLines(cb: (messages: MailMessage[]) => void): void {
    try {
      const stat = fs.statSync(this.mailFile)
      if (stat.size <= this._mailFileSize) return // no new data (or file was truncated)

      const fd = fs.openSync(this.mailFile, 'r')
      try {
        const buf = Buffer.alloc(stat.size - this._mailFileSize)
        fs.readSync(fd, buf, 0, buf.length, this._mailFileSize)
        this._mailFileSize = stat.size

        const newLines = buf.toString('utf8').split('\n').filter(Boolean)
        const newMessages: MailMessage[] = []
        for (const line of newLines) {
          try {
            const msg: MailMessage = JSON.parse(line)
            this._mailCache.push(msg)
            this._indexMail(msg)
            newMessages.push(msg)
          } catch { /* skip corrupt */ }
        }

        // Cap cache and indexes
        if (this._mailCache.length > AgentCoordinator.MAIL_CAP) {
          this._mailCache = this._mailCache.slice(-AgentCoordinator.MAIL_CAP)
        }
        this._capMailIndexes()

        if (newMessages.length > 0) cb(newMessages)
      } finally {
        fs.closeSync(fd)
      }
    } catch { /* file disappeared or unreadable — ignore */ }
  }

  /** Stop the mail file watcher. */
  unwatchMail(): void {
    if (this._mailWatcher) {
      this._mailWatcher.close()
      this._mailWatcher = null
    }
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

  /** Create a git worktree for an agent's isolated work */
  createWorktree(agentId: string, beadId: string): { worktreePath: string; branch: string } | null {
    const branch = `worker/${beadId}`
    const worktreePath = path.join(this.paths.worktreesDir, `worker-${beadId}`)

    try {
      // Get current branch
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.paths.projectRoot, timeout: 5000
      }).toString().trim()

      // Clean up stale worktree if exists
      if (fs.existsSync(worktreePath)) {
        try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.paths.projectRoot, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
        // Force-remove directory if git worktree remove didn't clean it
        try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
      }

      // Prune stale worktree references so git doesn't block creating new ones
      try { execSync('git worktree prune', { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }

      // Delete branch if it exists from a previous attempt
      try { execSync(`git branch -D "${branch}"`, { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }

      // Create worktree with new branch
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
      execSync(`git worktree add -b "${branch}" "${worktreePath}" "${currentBranch}"`, {
        cwd: this.paths.projectRoot, timeout: 15000
      })

      // Symlink .beads into worktree so bd CLI works there
      const beadsLink = path.join(worktreePath, '.beads')
      if (fs.existsSync(this.paths.beadsRoot) && !fs.existsSync(beadsLink)) {
        fs.symlinkSync(this.paths.beadsRoot, beadsLink, 'dir')
      }

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
      const ignoreEntries = ['.slashbot/', '.slashbotrc', '.beads/', '.worktrees/', '*.__merge_tmp/']
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
      // Fallback: return null to signal we should work in main dir
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
      const baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.paths.projectRoot, timeout: 5000
      }).toString().trim()

      // Verify agent branch is resolvable
      try {
        execSync(`git rev-parse --verify "${branch}"`, { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' })
      } catch {
        // Branch doesn't resolve — nothing to merge (brand-new worktree, no commits)
        this._cleanupWorktree(worktreePath, branch)
        return { merged: true, filesChanged: [] }
      }

      // Check if there are any new commits on the agent branch
      const diffOutput = execSync(`git log "${baseBranch}..${branch}" --oneline`, {
        cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe'
      }).toString().trim()

      if (!diffOutput) {
        this._cleanupWorktree(worktreePath, branch)
        return { merged: true, filesChanged: [] }
      }

      // Get list of files changed by the agent
      const filesOutput = execSync(`git diff --name-only "${baseBranch}..${branch}"`, {
        cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe'
      }).toString().trim()
      const filesChanged = filesOutput ? filesOutput.split('\n').filter(Boolean) : []

      let lastError = ''

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (stoppedFn?.()) {
          this._cleanupWorktree(worktreePath, branch)
          return { merged: false, filesChanged: [], error: 'stopped' }
        }

        // Step 1: Record current base ref for CAS (compare-and-swap)
        const oldBaseRef = execSync(`git rev-parse "${baseBranch}"`, {
          cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe'
        }).toString().trim()

        // Step 2: Check if base is already an ancestor of agent branch
        let mergeNeeded = true
        try {
          execSync(`git merge-base --is-ancestor "${oldBaseRef}" HEAD`, {
            cwd: worktreePath, timeout: 5000, stdio: 'pipe'
          })
          mergeNeeded = false
        } catch { /* base has moved ahead — merge needed */ }

        // Step 3: Merge base into agent branch (in agent's worktree — no global lock)
        if (mergeNeeded) {
          try {
            execSync(`git merge "${baseBranch}" --no-edit`, {
              cwd: worktreePath, timeout: 30000, stdio: 'pipe'
            })
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
                  execSync('git checkout --ours .', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' })
                  execSync('git add -A', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' })
                  execSync('git commit --no-edit', { cwd: worktreePath, timeout: 10000, stdio: 'pipe' })
                } catch {
                  // Last resort: abort and retry
                  try { execSync('git merge --abort', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
                  if (attempt >= maxRetries) break
                  continue
                }
              }
              // Conflict resolved — fall through to CAS
            } else if (isConflict) {
              // No Claude available — accept agent's version for conflicted files
              try {
                execSync('git checkout --ours .', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' })
                execSync('git add -A', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' })
                execSync('git commit --no-edit', { cwd: worktreePath, timeout: 10000, stdio: 'pipe' })
              } catch {
                try { execSync('git merge --abort', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
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
        const newRef = execSync('git rev-parse HEAD', {
          cwd: worktreePath, timeout: 5000, stdio: 'pipe'
        }).toString().trim()

        // Step 5: Atomic CAS — update base branch ref to agent tip
        // Fails if another agent moved the ref since we read oldBaseRef
        try {
          execSync(`git update-ref "refs/heads/${baseBranch}" ${newRef} ${oldBaseRef}`, {
            cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe'
          })
        } catch {
          // CAS failed — another agent updated the base. Undo merge and retry.
          lastError = 'update-ref CAS failed (concurrent merge)'
          if (mergeNeeded) {
            try { execSync('git reset --hard HEAD~1', { cwd: worktreePath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
          }
          if (attempt >= maxRetries) break
          continue
        }

        // Step 6: Sync main working tree (brief lock — only for checkout, not merge)
        await this._syncMainWorkingTree()

        this._cleanupWorktree(worktreePath, branch)
        return { merged: true, filesChanged, commitSha: newRef }
      }

      // Exhausted retries
      this._cleanupWorktree(worktreePath, branch)
      return { merged: false, filesChanged: [], error: lastError || 'exhausted retries' }
    } catch (err) {
      this._cleanupWorktree(worktreePath, branch)
      return { merged: false, filesChanged: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Briefly lock and sync the main working tree to match the updated HEAD ref. */
  private async _syncMainWorkingTree(): Promise<void> {
    await this.mergeSemaphore.acquire(30000)
    try {
      // Move untracked items that might conflict with the checkout
      const movedItems = this._moveConflictingItems()
      try {
        execSync('git reset --hard', { cwd: this.paths.projectRoot, timeout: 10000, stdio: 'pipe' })
      } finally {
        this._restoreMovedItems(movedItems)
      }
    } finally {
      this.mergeSemaphore.release()
    }
  }

  /** Move untracked symlinks/dirs (.slashbot, .beads, etc.) out of the way before checkout. */
  private _moveConflictingItems(): Array<{ path: string; symlinkTarget?: string }> {
    const movedItems: Array<{ path: string; symlinkTarget?: string }> = []
    for (const name of ['.slashbot', '.slashbotrc', '.beads', '.worktrees']) {
      const fullPath = path.join(this.paths.projectRoot, name)
      let stat: fs.Stats | null = null
      try { stat = fs.lstatSync(fullPath) } catch { continue }
      // Skip tracked files — reset --hard handles those
      try {
        execSync(`git ls-files --error-unmatch "${name}"`, { cwd: this.paths.projectRoot, timeout: 3000, stdio: 'pipe' })
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
      const conflicted = execSync('git diff --name-only --diff-filter=U', {
        cwd: workDir, timeout: 5000, stdio: 'pipe'
      }).toString().trim()

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
          try {
            const remaining = execSync('git diff --name-only --diff-filter=U', {
              cwd: workDir, timeout: 5000, stdio: 'pipe'
            }).toString().trim()
            if (remaining) { resolve(false); return }
            // Commit the merge resolution
            execSync('git commit --no-edit', { cwd: workDir, timeout: 10000, stdio: 'pipe' })
            resolve(true)
          } catch {
            resolve(false)
          }
        })
        proc.on('error', () => { clearTimeout(timer); resolve(false) })
      })
    } catch {
      return false
    }
  }

  private _cleanupWorktree(worktreePath: string, branch: string): void {
    try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.paths.projectRoot, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
    // Force-remove directory if git worktree remove didn't clean it up
    try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
    // Prune stale worktree references so git doesn't think the worktree still exists
    try { execSync('git worktree prune', { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
    try { execSync(`git branch -D "${branch}"`, { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
  }

  // ── Bead operations via bd CLI ─────────────────────────────────────────

  private claimSemaphore = new AsyncSemaphore()
  private commitSemaphore = new AsyncSemaphore()
  private mergeSemaphore = new AsyncSemaphore()

  /**
   * Reopen beads stuck in_progress past 2× claudeTimeoutMinutes when the
   * owning agent has no live heartbeat. Called at the start of claimBestBead
   * inside the claimSemaphore so it cannot race with other claim/reopen calls.
   */
  private _checkClaimTimeouts(claudeTimeoutMinutes: number): void {
    const thresholdMs = 2 * claudeTimeoutMinutes * 60_000
    const now = Date.now()
    const inProgress = this.bd.listByStatus('in_progress')

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
      this.reopenBead(beadAgent, bead.id)
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
      try { this._checkClaimTimeouts(claudeTimeoutMinutes) } catch { /* non-fatal */ }
      const lockedFiles = new Set(this.lockedFilesByOthers(agentId))

      // Get ALL open beads as candidates — we handle dep filtering ourselves.
      // bd ready is too strict (blocks beads with in_progress deps that we allow).
      let candidates: Bead[]
      try {
        candidates = await this.bd.listByStatusAsync('open')
      } catch (err) {
        this._log('ERROR', `[${agentId}] bd list failed: ${err instanceof Error ? err.message : err}`)
        candidates = this.bd.listByStatus('open')
      }

      let closedBeads: Bead[]
      let allBeads: Bead[]
      try {
        closedBeads = await this.bd.listByStatusAsync('closed')
        allBeads = await this.bd.listAllAsync()
      } catch (err) {
        this._log('ERROR', `[${agentId}] bd list failed, falling back to sync: ${err instanceof Error ? err.message : err}`)
        closedBeads = this.bd.listByStatus('closed')
        allBeads = this.bd.listAll()
      }
      const doneIds = new Set(closedBeads.map(b => b.id))
      const openChildCount = new Map<string, number>()
      for (const b of allBeads) {
        if (b.epicId && !doneIds.has(b.id)) {
          openChildCount.set(b.epicId, (openChildCount.get(b.epicId) ?? 0) + 1)
        }
      }

      // Read retry attempts to deprioritize beads that keep failing
      const retryCount = new Map<string, number>()
      for (const c of candidates) {
        try {
          const raw = await this.bd.getStateAsync(c.id, 'retry_attempt')
          const n = parseInt(raw, 10)
          if (!isNaN(n) && n > 0) retryCount.set(c.id, n)
        } catch { /* ignore — treat as 0 retries */ }
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

      // Beads in_progress can satisfy deps (speculative parallel execution).
      // Also treat parent beads as "in progress" if any of their children are being worked on.
      const inProgressIds = new Set(allBeads.filter(b => b.status === 'claimed').map(b => b.id))
      for (const b of allBeads) {
        if (b.status === 'claimed' && b.epicId) {
          // If a child is in_progress, its parent is effectively in_progress too
          inProgressIds.add(b.epicId)
        }
      }

      // Sort: retries → unresolved deps → priority → epic convergence → FIFO → ID
      candidates.sort((a, b) => {
        const retriesA = retryCount.get(a.id) ?? 0
        const retriesB = retryCount.get(b.id) ?? 0
        if (retriesA !== retriesB) return retriesA - retriesB
        // Count only truly blocked deps (not started yet) — in_progress deps are OK (speculative parallel)
        const blockedA = a.deps.filter(d => !doneIds.has(d) && !inProgressIds.has(d)).length + (openChildCount.get(a.id) ?? 0)
        const blockedB = b.deps.filter(d => !doneIds.has(d) && !inProgressIds.has(d)).length + (openChildCount.get(b.id) ?? 0)
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

      this._log('DEBUG', `[${agentId}] claimBestBead: ${candidates.length} candidates, ${closedBeads.length} done, ${inProgressIds.size} in_progress, ${lockedFiles.size} locked files`)

      for (const bead of candidates) {
        // Never pick up epics — they are containers, not work items.
        if (bead.type === 'epic') {
          this._log('DEBUG', `[${agentId}] skip ${bead.id}: epic`)
          continue
        }

        // Skip beads whose dependencies are not yet started.
        // Allow deps that are in_progress (speculative: they'll likely finish before this bead does)
        const blockedDeps = bead.deps.filter(d => !doneIds.has(d) && !inProgressIds.has(d)).length
        const openChildren = openChildCount.get(bead.id) ?? 0
        if (blockedDeps > 0 || openChildren > 0) {
          this._log('DEBUG', `[${agentId}] skip ${bead.id}: ${blockedDeps} blocked deps (not started), ${openChildren} open children`)
          continue
        }

        if (bead.files.some(f => lockedFiles.has(f))) {
          this._log('DEBUG', `[${agentId}] skip ${bead.id}: file locked`)
          continue
        }

        // Skip if actively claimed by another LIVE agent (check agent registry, not just claimedBy field)
        if (bead.claimedBy && bead.claimedBy !== agentId) {
          const liveAgents = this.getAgents().map(a => a.id)
          if (liveAgents.includes(bead.claimedBy)) {
            this._log('DEBUG', `[${agentId}] skip ${bead.id}: claimed by live agent ${bead.claimedBy}`)
            continue
          }
          // claimedBy is set but agent is not live — stale claim, try to take it
          this._log('DEBUG', `[${agentId}] ${bead.id}: stale claim by ${bead.claimedBy}, attempting takeover`)
        }

        // Assign directly to this agent
        let assigned = false
        try { assigned = await this.bd.assignToAsync(bead.id, agentId) }
        catch { assigned = this.bd.assignTo(bead.id, agentId) }
        if (!assigned) {
          this._log('DEBUG', `[${agentId}] skip ${bead.id}: assignTo failed`)
          continue
        }

        this.reserveFiles(agentId, bead.id, bead.files)
        this.postActivity({ agentId, type: 'claimed', beadId: bead.id, beadTitle: bead.title, summary: `Claimed bead [${bead.id}] ${bead.title}` })
        // Preserve original title — bd show may return a corrupted title after set-state
        const originalTitle = bead.title
        let freshBead: Bead | null = null
        try { freshBead = await this.bd.showAsync(bead.id) }
        catch { freshBead = this.bd.show(bead.id) }
        const result = freshBead ?? { ...bead, status: 'claimed', claimedBy: agentId }
        if (originalTitle && result.title !== originalTitle) {
          result.title = originalTitle
        }
        return result
      }
      this._log('DEBUG', `[${agentId}] claimBestBead: no suitable candidate found`)
      return null
    } finally {
      this.claimSemaphore.release()
    }
  }

  async completeBead(agentId: string, beadId: string, filesChanged?: string[], autoPush = true): Promise<void> {
    // Idempotency: skip if bead is already done
    try {
      const current = this.bd.show(beadId)
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
      this.bd.close(beadId, `Completed by ${agentId}`)
    } catch (err) {
      // bd close can fail for epics with open children — don't crash the worker
      const msg = err instanceof Error ? err.message : String(err)
      this.postActivity({ agentId, type: 'info' as any, beadId, summary: `Close failed (non-fatal): ${msg.slice(0, 120)}` })
    }

    this.postActivity({ agentId, type: 'completed', beadId, filesChanged, commitSha: commitSha ?? undefined, summary: `Completed [${beadId}]${filesChanged?.length ? ` — ${filesChanged.length} files` : ''}` })

    // Auto-close parent epic if all siblings are done
    this._maybeCloseEpic(agentId, beadId)
  }

  /**
   * If the completed bead has a parent epic, check whether all siblings under
   * that epic are now done. If so, close the epic automatically.
   * Leverages idempotent close — a spurious double-close is harmless.
   */
  private _maybeCloseEpic(agentId: string, beadId: string): void {
    try {
      const bead = this.bd.show(beadId)
      if (!bead?.epicId) return

      const epicId = bead.epicId
      const epic = this.bd.show(epicId)
      if (!epic || epic.status === 'done') return // already closed or missing

      const allBeads = this.bd.listAll()
      const siblings = allBeads.filter(b => b.epicId === epicId && b.id !== epicId)
      if (siblings.length === 0) return

      const allDone = siblings.every(b => b.status === 'done')
      if (!allDone) return

      this.bd.close(epicId, `All children completed — auto-closed by ${agentId}`)
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
      // Stage everything (merged code + .beads db changes)
      execSync('git add -A', { cwd: this.paths.projectRoot, timeout: 10000, stdio: 'pipe' })

      // Check if there's anything to commit
      try {
        execSync('git diff --cached --quiet', { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' })
        return null // nothing staged
      } catch { /* has staged changes — continue */ }

      // Commit
      const msg = `feat: complete bead ${beadId} [${agentId}]`
      execSync(`git commit -m ${JSON.stringify(msg)}`, {
        cwd: this.paths.projectRoot, timeout: 10000, stdio: 'pipe',
        env: { ...process.env, GIT_AUTHOR_NAME: agentId, GIT_COMMITTER_NAME: agentId }
      })

      // Capture the commit SHA
      let commitSha: string | null = null
      try {
        commitSha = execSync('git rev-parse HEAD', {
          cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe'
        }).toString().trim()
      } catch { /* non-fatal — SHA capture failed */ }

      // Push to remote (current branch)
      if (autoPush) {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe'
          }).toString().trim()
          execSync(`git push origin ${branch}`, { cwd: this.paths.projectRoot, timeout: 30000, stdio: 'pipe' })
        } catch (err) {
          // Push may fail if no remote or no upstream — non-fatal
          const msg = err instanceof Error ? err.message : String(err)
          this.postActivity({ agentId, type: 'info' as any, summary: `Push failed (non-fatal): ${msg.slice(0, 100)}` })
        }
      }

      return commitSha
    } finally {
      this.commitSemaphore.release()
    }
  }

  reopenBead(agentId: string, beadId: string): void {
    // Idempotency: skip if bead is already open
    try {
      const current = this.bd.show(beadId)
      if (current?.status === 'ready') {
        this.releaseFiles(agentId, beadId)
        return
      }
    } catch { /* bead not found — proceed and let bd.reopen handle the error */ }

    this.bd.reopen(beadId, `Reopened by ${agentId} for retry`)
    this.releaseFiles(agentId, beadId)
  }

  /** Reopen any beads left in claimed/in_progress from a previous session */
  reopenStaleBeads(): void {
    const claimed = this.bd.listByStatus('in_progress')
    for (const bead of claimed) {
      try {
        this.bd.reopen(bead.id, 'Reopened on startup — stale from previous session')
        this.postActivity({ agentId: 'system', type: 'info' as any, beadId: bead.id, beadTitle: bead.title, summary: `Reopened stale bead [${bead.id}]` })
      } catch { /* ignore — may already be open */ }
    }
    // Clear all file locks from previous session
    this.clearAllFileLocks()
    // Clean up orphaned worktrees from previous session
    this.cleanOrphanedWorktrees()
    // Prune stale git worktree references
    try { execSync('git worktree prune', { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
  }

  /**
   * Rollback a bead by reverting its commits in reverse chronological order.
   * Reads commit SHAs from the activity cache, filters to only the last successful
   * merged+completed pair (ignoring events before a failed/reopened event),
   * deduplicates, reverts via git revert --no-edit, aborts on conflict,
   * reopens the bead, and posts a rollback activity event.
   */
  rollbackBead(agentId: string, beadId: string): { reverted: boolean; revertedShas: string[]; error?: string } {
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
        execSync(`git revert --no-edit ${sha}`, {
          cwd: this.paths.projectRoot, timeout: 15000, stdio: 'pipe'
        })
        revertedShas.push(sha)
      } catch (err) {
        // Conflict during revert — abort and return error
        try {
          execSync('git revert --abort', { cwd: this.paths.projectRoot, timeout: 5000, stdio: 'pipe' })
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
      this.bd.reopen(beadId, `Rolled back by ${agentId}`)
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

  failBead(agentId: string, beadId: string, reason: string): void {
    // Idempotency: skip if bead is already failed
    try {
      const current = this.bd.show(beadId)
      if (current?.status === 'failed') {
        this.releaseFiles(agentId, beadId)
        this.postActivity({ agentId, type: 'failed', beadId, summary: `${reason} (already failed)` })
        return
      }
    } catch { /* bead not found — proceed and let bd.close handle the error */ }

    this.bd.addLabel(beadId, 'failed')
    this.bd.close(beadId, `Failed: ${reason}`)
    this.releaseFiles(agentId, beadId)
    this.postActivity({ agentId, type: 'failed', beadId, summary: reason })
  }

  /** Remove worktree directories not owned by any registered agent. */
  cleanOrphanedWorktrees(): string[] {
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
        this._cleanupWorktree(wtPath, branch)
      }
      // Fallback: rm dir if git worktree remove didn't work
      try { if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true }) } catch { /* ignore */ }
      removed.push(entry.name)
    }
    return removed
  }

  hasOpenWork(): boolean {
    if (this.planningActive) return true
    const open = this.bd.listByStatus('open')
    if (open.length > 0) return true
    const inProgress = this.bd.listByStatus('in_progress')
    return inProgress.length > 0
  }

  async hasOpenWorkAsync(): Promise<boolean> {
    if (this.planningActive) return true
    const open = await this.bd.listByStatusAsync('open')
    if (open.length > 0) return true
    const inProgress = await this.bd.listByStatusAsync('in_progress')
    return inProgress.length > 0
  }

  getStats(): BeadStats {
    return this.bd.stats()
  }

  async getStatsAsync(): Promise<BeadStats> {
    return this.bd.statsAsync()
  }
}
