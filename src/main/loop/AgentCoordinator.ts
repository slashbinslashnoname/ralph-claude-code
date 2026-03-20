import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
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

  constructor(private ralphDir: string, private projectPath: string) {
    this.lockFile = path.join(ralphDir, 'file_locks.json')
    this.agentsFile = path.join(ralphDir, 'agents.json')
    this.activityFile = path.join(ralphDir, 'activity.jsonl')
    fs.mkdirSync(ralphDir, { recursive: true })
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
    fs.appendFileSync(this.activityFile, JSON.stringify(full) + '\n')
  }

  readActivity(limit = 50): ActivityEvent[] {
    if (!fs.existsSync(this.activityFile)) return []
    try {
      return fs
        .readFileSync(this.activityFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map(l => JSON.parse(l))
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
        try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.projectPath, timeout: 10000 }) } catch { /* ignore */ }
      }

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

      // Symlink .ralph into worktree so agent context is available
      const ralphLink = path.join(worktreePath, '.ralph')
      if (fs.existsSync(this.ralphDir) && !fs.existsSync(ralphLink)) {
        fs.symlinkSync(this.ralphDir, ralphLink, 'dir')
      }

      // Symlink .ralphrc
      const ralphrcSrc = path.join(this.projectPath, '.ralphrc')
      const ralphrcLink = path.join(worktreePath, '.ralphrc')
      if (fs.existsSync(ralphrcSrc) && !fs.existsSync(ralphrcLink)) {
        fs.symlinkSync(ralphrcSrc, ralphrcLink, 'file')
      }

      // Ensure symlinks are not committed by the agent
      const wtGitignore = path.join(worktreePath, '.gitignore')
      const ignoreEntries = ['.ralph/', '.ralphrc', '.beads/', '.worktrees/']
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
  mergeWorktree(
    agentId: string, beadId: string, branch: string, worktreePath: string,
    opts?: { maxRetries?: number; stoppedFn?: () => boolean }
  ): { merged: boolean; filesChanged: string[]; error?: string } {
    const maxRetries = opts?.maxRetries ?? 2
    const stoppedFn = opts?.stoppedFn

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = this._tryMerge(branch, worktreePath)
      if (result.merged) {
        this._cleanupWorktree(worktreePath, branch)
        return result
      }

      // No more retries or agent is stopping — give up
      if (attempt >= maxRetries || (stoppedFn && stoppedFn())) {
        this._cleanupWorktree(worktreePath, branch)
        return result
      }

      // Pull latest before retrying (abort failed merge first)
      try { execSync('git merge --abort', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
      try { execSync('git pull --rebase=false', { cwd: this.projectPath, timeout: 15000, stdio: 'pipe' }) } catch { /* ignore */ }
    }

    // Should not reach here, but be safe
    this._cleanupWorktree(worktreePath, branch)
    return { merged: false, filesChanged: [], error: 'exhausted retries' }
  }

  /** Single merge attempt — does not clean up worktree on failure. */
  private _tryMerge(branch: string, worktreePath: string): { merged: boolean; filesChanged: string[]; error?: string } {
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectPath, timeout: 5000
      }).toString().trim()

      const diffOutput = execSync(`git log "${currentBranch}..${branch}" --oneline`, {
        cwd: this.projectPath, timeout: 5000
      }).toString().trim()

      if (!diffOutput) {
        return { merged: true, filesChanged: [] }
      }

      const filesOutput = execSync(`git diff --name-only "${currentBranch}..${branch}"`, {
        cwd: this.projectPath, timeout: 5000
      }).toString().trim()
      const filesChanged = filesOutput ? filesOutput.split('\n').filter(Boolean) : []

      // Move untracked files/symlinks that would conflict with the merge
      const movedItems: { path: string; symlinkTarget?: string }[] = []
      for (const name of ['.ralph', '.ralphrc', '.beads', '.worktrees']) {
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
          fs.renameSync(fullPath, tmp)
          movedItems.push({ path: fullPath })
        }
      }

      try {
        execSync(`git merge "${branch}" --no-edit`, {
          cwd: this.projectPath, timeout: 30000
        })
      } finally {
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
      try { execSync('git merge --abort', { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
      return { merged: false, filesChanged: [], error: msg }
    }
  }

  private _cleanupWorktree(worktreePath: string, branch: string): void {
    try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.projectPath, timeout: 10000, stdio: 'pipe' }) } catch { /* ignore */ }
    try { execSync(`git branch -D "${branch}"`, { cwd: this.projectPath, timeout: 5000, stdio: 'pipe' }) } catch { /* ignore */ }
  }

  // ── Bead operations via bd CLI ─────────────────────────────────────────

  private claimSemaphore = new AsyncSemaphore()

  async claimBestBead(agentId: string): Promise<Bead | null> {
    await this.claimSemaphore.acquire(5000)

    try {
      const lockedFiles = new Set(this.lockedFilesByOthers(agentId))

      let candidates = this.bd.ready()
      if (candidates.length === 0) {
        candidates = this.bd.listByStatus('open')
      }
      // Sort by priority (P0 first) then by creation order
      candidates.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))

      for (const bead of candidates) {
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

  completeBead(agentId: string, beadId: string, filesChanged?: string[]): void {
    this.bd.close(beadId, `Completed by ${agentId}`)
    this.releaseFiles(agentId, beadId)
    this.postActivity({ agentId, type: 'completed', beadId, filesChanged, summary: `Completed [${beadId}]${filesChanged?.length ? ` — ${filesChanged.length} files` : ''}` })
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
    const open = this.bd.listByStatus('open')
    if (open.length > 0) return true
    const inProgress = this.bd.listByStatus('in_progress')
    return inProgress.length > 0
  }

  getStats(): BeadStats {
    return this.bd.stats()
  }
}
