import * as fs from 'fs'
import * as path from 'path'
import { execSync, spawn } from 'child_process'
import { BdClient } from './BdClient'
import { Bead, BeadStats, FileLock, AgentInfo, ActivityEvent } from '../types'
import { AsyncSemaphore } from './AsyncSemaphore'

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
  bd: BdClient
  planningActive = false

  constructor(private slashbotDir: string, private projectPath: string) {
    this.lockFile = path.join(slashbotDir, 'file_locks.json')
    this.agentsFile = path.join(slashbotDir, 'agents.json')
    this.activityFile = path.join(slashbotDir, 'activity.jsonl')
    fs.mkdirSync(slashbotDir, { recursive: true })
    this.bd = new BdClient(projectPath)
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
    const full = { ts: new Date().toISOString(), ...event }
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
  }

  readActivity(limit = 50): ActivityEvent[] {
    if (!fs.existsSync(this.activityFile)) return []
    try {
      const lines = fs
        .readFileSync(this.activityFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
      const results: ActivityEvent[] = []
      for (const line of lines) {
        try { results.push(JSON.parse(line)) } catch { /* skip corrupt line */ }
      }
      return results
    } catch { return [] }
  }

  // ── Git worktree management ─────────────────────────────────────────────

  /** Create a git worktree for an agent's isolated work */
  createWorktree(agentId: string, beadId: string): { worktreePath: string; branch: string } | null {
    const branch = `agent/${agentId}/${beadId}`
    const worktreePath = path.join(this.projectPath, '.worktrees', `${agentId}-${beadId}`)

    try {
      // Get current branch
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 5000
      }).toString().trim()

      // Clean up stale worktree if exists
      if (fs.existsSync(worktreePath)) {
        try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
        // Force-remove directory if git worktree remove didn't clean it
        try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
      }

      // Prune stale worktree references so git doesn't block creating new ones
      try { execSync('git worktree prune', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }

      // Delete branch if it exists from a previous attempt
      try { execSync(`git branch -D "${branch}"`, { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }

      // Create worktree with new branch
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
      execSync(`git worktree add -b "${branch}" "${worktreePath}" "${currentBranch}"`, {
        cwd: this.projectPath, timeout: 15000
      })

      // Symlink .beads into worktree so bd CLI works there
      const beadsDir = path.join(this.projectPath, '.beads')
      const beadsLink = path.join(worktreePath, '.beads')
      if (fs.existsSync(beadsDir) && !fs.existsSync(beadsLink)) {
        fs.symlinkSync(beadsDir, beadsLink, 'dir')
      }

      // Symlink .slashbot into worktree so agent context is available
      const slashbotLink = path.join(worktreePath, '.slashbot')
      if (fs.existsSync(this.slashbotDir) && !fs.existsSync(slashbotLink)) {
        fs.symlinkSync(this.slashbotDir, slashbotLink, 'dir')
      }

      // Symlink .slashbotrc
      const slashbotrcSrc = path.join(this.projectPath, '.slashbotrc')
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
   *  Retries up to maxRetries times on conflict, pulling before each retry.
   *  If stoppedFn returns true, retries are skipped. */
  async mergeWorktree(
    agentId: string, beadId: string, branch: string, worktreePath: string,
    opts?: { maxRetries?: number; stoppedFn?: () => boolean; claudeCmd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ merged: boolean; filesChanged: string[]; error?: string }> {
    // Serialize all merge operations — concurrent merges into the same main
    // working tree corrupt git state (stash/merge/stash-pop race).
    await this.mergeSemaphore.acquire(120000)
    try {
      return await this._mergeWorktreeInner(agentId, beadId, branch, worktreePath, opts)
    } finally {
      this.mergeSemaphore.release()
    }
  }

  private async _mergeWorktreeInner(
    agentId: string, beadId: string, branch: string, worktreePath: string,
    opts?: { maxRetries?: number; stoppedFn?: () => boolean; claudeCmd?: string; env?: NodeJS.ProcessEnv }
  ): Promise<{ merged: boolean; filesChanged: string[]; error?: string }> {
    const maxRetries = opts?.maxRetries ?? 2
    const stoppedFn = opts?.stoppedFn

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = this._tryMerge(branch, worktreePath)
      if (result.merged) {
        this._cleanupWorktree(worktreePath, branch)
        return result
      }

      // No more retries or agent is stopping — give up without LLM
      if (attempt >= maxRetries || (stoppedFn && stoppedFn())) {
        this._cleanupWorktree(worktreePath, branch)
        return result
      }

      // Attempt LLM-assisted conflict resolution (merge is still in progress, conflicts in working tree)
      const isConflict = result.error?.includes('CONFLICT') || result.error?.includes('CONFLIT') || result.error?.includes('Merge conflict')
      if (isConflict && opts?.claudeCmd) {
        const resolved = await this._resolveConflictsWithClaude(opts.claudeCmd, opts.env)
        if (resolved) {
          this._cleanupWorktree(worktreePath, branch)
          return { merged: true, filesChanged: result.filesChanged }
        }
      }

      // Abort the failed/unresolved merge and pull latest before retrying
      try { execSync('git merge --abort', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
      try { execSync('git pull --rebase=false', { cwd: this.projectPath, timeout: 15000, stdio: 'pipe' }) } catch { /* ignore */ }
    }

    // Should not reach here, but be safe
    this._cleanupWorktree(worktreePath, branch)
    return { merged: false, filesChanged: [], error: 'exhausted retries' }
  }

  /** Use Claude to resolve merge conflicts in the working directory */
  private async _resolveConflictsWithClaude(claudeCmd: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
    try {
      // Get list of conflicted files
      const conflicted = execSync('git diff --name-only --diff-filter=U', {
        cwd: this.projectPath, timeout: 5000, stdio: 'pipe'
      }).toString().trim()

      if (!conflicted) return false

      const files = conflicted.split('\n').filter(Boolean)
      const fileList = files.join(', ')

      const prompt = `You are resolving git merge conflicts. The following files have conflicts:\n${fileList}\n\nFor each file, read it, resolve ALL conflict markers (<<<<<<< ======= >>>>>>>), keeping the best version of both sides. Then stage the resolved files with git add. Do NOT commit.`

      return new Promise<boolean>((resolve) => {
        const proc = spawn(claudeCmd, ['-p', prompt, '--dangerously-skip-permissions'], {
          cwd: this.projectPath, env: env ?? process.env,
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
              cwd: this.projectPath, timeout: 5000, stdio: 'pipe'
            }).toString().trim()
            if (remaining) { resolve(false); return }
            // Commit the merge resolution
            execSync('git commit --no-edit', { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' })
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

  /** Single merge attempt — does not clean up worktree on failure. */
  private _tryMerge(branch: string, worktreePath: string): { merged: boolean; filesChanged: string[]; error?: string } {
    // Declared outside try so it's accessible in the catch block
    let stashed = false
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 5000
      }).toString().trim()

      // Verify both refs are resolvable before using .. range syntax.
      // A freshly created worktree branch may not be resolvable from the main
      // working tree if git hasn't flushed refs yet.
      try {
        execSync(`git rev-parse --verify "${branch}"`, { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' })
      } catch {
        // Branch doesn't resolve — nothing to merge (brand-new worktree, no commits)
        return { merged: true, filesChanged: [] }
      }

      const diffOutput = execSync(`git log "${currentBranch}..${branch}" --oneline`, {
        cwd: this.projectPath, timeout: 5000, stdio: 'pipe'
      }).toString().trim()

      if (!diffOutput) {
        return { merged: true, filesChanged: [] }
      }

      const filesOutput = execSync(`git diff --name-only "${currentBranch}..${branch}"`, {
        cwd: this.projectPath, timeout: 5000, stdio: 'pipe'
      }).toString().trim()
      const filesChanged = filesOutput ? filesOutput.split('\n').filter(Boolean) : []

      // Move untracked files/symlinks that would conflict with the merge
      const movedItems: { path: string; symlinkTarget?: string }[] = []
      for (const name of ['.slashbot', '.slashbotrc', '.beads', '.worktrees']) {
        const fullPath = path.join(this.projectPath, name)
        let stat: fs.Stats | null = null
        try { stat = fs.lstatSync(fullPath) } catch { continue }
        try {
          execSync(`git ls-files --error-unmatch "${name}"`, { cwd: this.projectPath, timeout: 3000, stdio: 'pipe' })
          continue
        } catch { /* untracked */ }
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(fullPath)
          fs.unlinkSync(fullPath)
          movedItems.push({ path: fullPath, symlinkTarget: target })
        } else {
          const tmp = fullPath + '.__merge_tmp'
          // Remove leftover tmp from a previous failed merge
          try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ok */ }
          fs.renameSync(fullPath, tmp)
          movedItems.push({ path: fullPath })
        }
      }

      // Stash any pending local modifications so merge doesn't fail
      try {
        const stashOut = execSync('git stash push -m "slashbot-merge-tmp" --include-untracked', {
          cwd: this.projectPath, timeout: 10000, stdio: 'pipe'
        }).toString()
        stashed = !stashOut.includes('No local changes')
      } catch { /* nothing to stash */ }

      try {
        execSync(`git merge "${branch}" --no-edit`, {
          cwd: this.projectPath, timeout: 30000
        })
      } finally {
        // Restore stash BEFORE restoring moved items — stash may contain the .__merge_tmp
        // dirs (since --include-untracked stashes them), so they must be popped first.
        if (stashed) {
          try { execSync('git stash pop', { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
          stashed = false
        }
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

      return { merged: true, filesChanged }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isConflict = msg.includes('CONFLICT') || msg.includes('CONFLIT') || msg.includes('Merge conflict')
      // Don't abort if it's a conflict — caller may try LLM resolution
      if (!isConflict) {
        try { execSync('git merge --abort', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
      }
      // Restore stashed changes even on failure (stash may already be popped by finally block)
      if (stashed) {
        try { execSync('git stash pop', { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
      }
      return { merged: false, filesChanged: [], error: msg }
    }
  }

  private _cleanupWorktree(worktreePath: string, branch: string): void {
    try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
    // Force-remove directory if git worktree remove didn't clean it up
    try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
    // Prune stale worktree references so git doesn't think the worktree still exists
    try { execSync('git worktree prune', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
    try { execSync(`git branch -D "${branch}"`, { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
  }

  // ── Bead operations via bd CLI ─────────────────────────────────────────

  private claimSemaphore = new AsyncSemaphore()
  private mergeSemaphore = new AsyncSemaphore()

  async claimBestBead(agentId: string): Promise<Bead | null> {
    await this.claimSemaphore.acquire(5000)

    try {
      const lockedFiles = new Set(this.lockedFilesByOthers(agentId))

      let candidates = this.bd.ready()
      if (candidates.length === 0) {
        candidates = this.bd.listByStatus('open')
      }
      // Build sets for dependency resolution
      const closedBeads = this.bd.listByStatus('closed')
      const doneIds = new Set(closedBeads.map(b => b.id))

      // Count non-closed children per parent (epics/tasks with open children should wait)
      const allBeads = this.bd.listAll()
      const openChildCount = new Map<string, number>()
      for (const b of allBeads) {
        if (b.epicId && !doneIds.has(b.id)) {
          openChildCount.set(b.epicId, (openChildCount.get(b.epicId) ?? 0) + 1)
        }
      }

      // Read retry attempts to deprioritize beads that keep failing
      const retryCount = new Map<string, number>()
      for (const c of candidates) {
        const raw = this.bd.getState(c.id, 'retry_attempt')
        const n = parseInt(raw, 10)
        if (!isNaN(n) && n > 0) retryCount.set(c.id, n)
      }

      // Sort: fewest retries first, then fewest unresolved deps + open children, then priority
      candidates.sort((a, b) => {
        const retriesA = retryCount.get(a.id) ?? 0
        const retriesB = retryCount.get(b.id) ?? 0
        if (retriesA !== retriesB) return retriesA - retriesB
        const unresolvedA = a.deps.filter(d => !doneIds.has(d)).length + (openChildCount.get(a.id) ?? 0)
        const unresolvedB = b.deps.filter(d => !doneIds.has(d)).length + (openChildCount.get(b.id) ?? 0)
        if (unresolvedA !== unresolvedB) return unresolvedA - unresolvedB
        return (a.priority ?? 2) - (b.priority ?? 2)
      })

      for (const bead of candidates) {
        // Never pick up epics — they are containers, not work items.
        // Epics close automatically when all children are done.
        if (bead.type === 'epic') continue

        if (bead.files.some(f => lockedFiles.has(f))) continue

        // Skip if already claimed by another agent
        if (bead.claimedBy && bead.claimedBy.startsWith('agent-') && bead.claimedBy !== agentId) continue

        // Assign directly to this agent
        if (!this.bd.assignTo(bead.id, agentId)) continue

        this.reserveFiles(agentId, bead.id, bead.files)
        this.postActivity({ agentId, type: 'claimed', beadId: bead.id, beadTitle: bead.title, summary: `Claimed bead [${bead.id}] ${bead.title}` })
        return this.bd.show(bead.id) ?? { ...bead, status: 'claimed', claimedBy: agentId }
      }
      return null
    } finally {
      this.claimSemaphore.release()
    }
  }

  completeBead(agentId: string, beadId: string, filesChanged?: string[], autoPush = true): void {
    try {
      this.bd.close(beadId, `Completed by ${agentId}`)
    } catch (err) {
      // bd close can fail for epics with open children — don't crash the worker
      const msg = err instanceof Error ? err.message : String(err)
      this.postActivity({ agentId, type: 'info' as any, beadId, summary: `Close failed (non-fatal): ${msg.slice(0, 120)}` })
    }
    this.releaseFiles(agentId, beadId)
    this.postActivity({ agentId, type: 'completed', beadId, filesChanged, summary: `Completed [${beadId}]${filesChanged?.length ? ` — ${filesChanged.length} files` : ''}` })

    // Commit and push all changes on the current branch
    this.commitAndPush(agentId, beadId, autoPush)
  }

  /** Commit any pending changes and push to remote */
  commitAndPush(agentId: string, beadId: string, autoPush = true): void {
    try {
      // Stage everything (merged code + .beads db changes)
      execSync('git add -A', { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' })

      // Check if there's anything to commit
      try {
        execSync('git diff --cached --quiet', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' })
        return // nothing staged
      } catch { /* has staged changes — continue */ }

      // Commit
      const msg = `feat: complete bead ${beadId} [${agentId}]`
      execSync(`git commit -m ${JSON.stringify(msg)}`, {
        cwd: this.projectPath, timeout: 10000, stdio: 'pipe',
        env: { ...process.env, GIT_AUTHOR_NAME: agentId, GIT_COMMITTER_NAME: agentId }
      })

      // Push to remote (current branch)
      if (autoPush) {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: this.projectPath, timeout: 5000, stdio: 'pipe'
          }).toString().trim()
          execSync(`git push origin ${branch}`, { cwd: this.projectPath, timeout: 30000, stdio: 'pipe' })
        } catch (err) {
          // Push may fail if no remote or no upstream — non-fatal
          const msg = err instanceof Error ? err.message : String(err)
          this.postActivity({ agentId, type: 'info' as any, summary: `Push failed (non-fatal): ${msg.slice(0, 100)}` })
        }
      }
    } catch { /* commit failed — non-fatal */ }
  }

  reopenBead(agentId: string, beadId: string): void {
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
    try { execSync('git worktree prune', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
  }

  failBead(agentId: string, beadId: string, reason: string): void {
    this.bd.addLabel(beadId, 'failed')
    this.bd.close(beadId, `Failed: ${reason}`)
    this.releaseFiles(agentId, beadId)
    this.postActivity({ agentId, type: 'failed', beadId, summary: reason })
  }

  /** Remove worktree directories not owned by any registered agent. */
  cleanOrphanedWorktrees(): string[] {
    const worktreesDir = path.join(this.projectPath, '.worktrees')
    if (!fs.existsSync(worktreesDir)) return []

    const agents = new Set(this.readAgents().map(a => a.id))
    const removed: string[] = []

    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(worktreesDir, { withFileTypes: true }) } catch { return [] }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Worktree dirs are named <agentId>-<beadId>, e.g. "agent-0-sb-abc"
      const parts = entry.name.split('-')
      const agentId = parts.slice(0, 2).join('-') // e.g. "agent-0"
      if (agents.has(agentId)) continue // owned by active agent

      const wtPath = path.join(worktreesDir, entry.name)
      const beadId = parts.slice(2).join('-') // e.g. "sb-abc"
      const branch = `agent/${agentId}/${beadId}`
      this._cleanupWorktree(wtPath, branch)
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

  getStats(): BeadStats {
    return this.bd.stats()
  }
}
