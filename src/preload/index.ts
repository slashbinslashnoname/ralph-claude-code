import { contextBridge, ipcRenderer } from 'electron'

function listen(channel: string, cb: (...args: unknown[]) => void): () => void {
  const handler = (_e: unknown, ...args: unknown[]): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('ralph', {
  // ── Project management ──────────────────────────────────────────────────
  selectProject: () => ipcRenderer.invoke('project:select'),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  addProject: (p: string) => ipcRenderer.invoke('project:add', p),
  activeProjectTabs: () => ipcRenderer.invoke('project:active-tabs'),
  saveActiveProjectTabs: (tabs: { paths: string[]; active: number }) =>
    ipcRenderer.invoke('project:save-tabs', tabs),

  // ── Ralph enable ────────────────────────────────────────────────────────
  isEnabled: (projectPath: string) => ipcRenderer.invoke('ralph:is-enabled', projectPath),
  enable: (projectPath: string, opts: unknown) => ipcRenderer.invoke('ralph:enable', projectPath, opts),

  // ── Status ──────────────────────────────────────────────────────────────
  readStatus: (projectPath: string) => ipcRenderer.invoke('status:read', projectPath),
  subscribeStatus: (projectPath: string) => ipcRenderer.invoke('status:subscribe', projectPath),
  unsubscribeStatus: (projectPath: string) => ipcRenderer.invoke('status:unsubscribe', projectPath),

  onStatusUpdate: (cb: (...a: unknown[]) => void) => listen('status:update', cb),
  onProgressUpdate: (cb: (...a: unknown[]) => void) => listen('progress:update', cb),
  onCircuitUpdate: (cb: (...a: unknown[]) => void) => listen('circuit:update', cb),
  onAnalysisUpdate: (cb: (...a: unknown[]) => void) => listen('analysis:update', cb),
  onLogLines: (cb: (...a: unknown[]) => void) => listen('logs:lines', cb),
  onRalphExit: (cb: (...a: unknown[]) => void) => listen('ralph:exit', cb),
  onPtyData: (cb: (...a: unknown[]) => void) => listen('pty:data', cb),

  // ── Logs ────────────────────────────────────────────────────────────────
  readLogs: (projectPath: string, lines?: number) => ipcRenderer.invoke('logs:read', projectPath, lines),
  listLogs: (projectPath: string) => ipcRenderer.invoke('logs:list', projectPath),

  // ── File editor ───────────────────────────────────────────────────────
  readFile: (projectPath: string, relPath: string) => ipcRenderer.invoke('file:read', projectPath, relPath),
  writeFile: (projectPath: string, relPath: string, content: string) =>
    ipcRenderer.invoke('file:write', projectPath, relPath, content),

  // ── Ralph loop ────────────────────────────────────────────────────────
  startRalph: (projectPath: string) => ipcRenderer.invoke('ralph:start', projectPath),
  stopRalph: (projectPath: string) => ipcRenderer.invoke('ralph:stop', projectPath),
  ralphRunning: (projectPath: string) => ipcRenderer.invoke('ralph:running', projectPath),

  // ── Terminal ──────────────────────────────────────────────────────────
  ptyWrite: (projectPath: string, data: string) => ipcRenderer.invoke('pty:write', projectPath, data),
  ptyResize: (cols: number, rows: number) => ipcRenderer.invoke('pty:resize', cols, rows),

  // ── Circuit breaker & session ────────────────────────────────────────
  resetCircuit: (projectPath: string) => ipcRenderer.invoke('circuit:reset', projectPath),
  resetSession: (projectPath: string) => ipcRenderer.invoke('session:reset', projectPath),

  // ── Beads (via bd CLI) ───────────────────────────────────────────────
  beads: {
    check: (projectPath: string) => ipcRenderer.invoke('beads:check', projectPath),
    list: (projectPath: string, filter?: string) =>
      ipcRenderer.invoke('beads:list', projectPath, filter ?? 'open'),
    show: (projectPath: string, id: string) => ipcRenderer.invoke('beads:show', projectPath, id),
    create: (projectPath: string, opts: unknown) => ipcRenderer.invoke('beads:create', projectPath, opts),
    update: (projectPath: string, id: string, opts: unknown) =>
      ipcRenderer.invoke('beads:update', projectPath, id, opts),
    close: (projectPath: string, id: string, reason?: string) =>
      ipcRenderer.invoke('beads:close', projectPath, id, reason ?? 'Done'),
    reopen: (projectPath: string, id: string, reason?: string) =>
      ipcRenderer.invoke('beads:reopen', projectPath, id, reason),
    ready: (projectPath: string) => ipcRenderer.invoke('beads:ready', projectPath),
    stats: (projectPath: string) => ipcRenderer.invoke('beads:stats', projectPath),
  },

  // ── Swarm orchestrator ───────────────────────────────────────────────
  swarm: {
    inject: (projectPath: string, request: string) =>
      ipcRenderer.invoke('swarm:inject', projectPath, request),
    queueRemove: (projectPath: string, id: string) =>
      ipcRenderer.invoke('swarm:queue-remove', projectPath, id),
    queue: (projectPath: string) => ipcRenderer.invoke('swarm:queue', projectPath),
    start: (projectPath: string, workerCount?: number) =>
      ipcRenderer.invoke('swarm:start', projectPath, workerCount ?? 2),
    stop: (projectPath: string) => ipcRenderer.invoke('swarm:stop', projectPath),
    status: (projectPath: string) => ipcRenderer.invoke('swarm:status', projectPath),
    beads: (projectPath: string, status?: string) =>
      ipcRenderer.invoke('swarm:beads', projectPath, status),
    beadStats: (projectPath: string) => ipcRenderer.invoke('swarm:bead-stats', projectPath),
    activity: (projectPath: string, limit?: number) =>
      ipcRenderer.invoke('swarm:activity', projectPath, limit ?? 50),
    agentOutput: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke('swarm:agent-output', projectPath, agentId),
    onLog: (cb: (...a: unknown[]) => void) => listen('swarm:log', cb),
    onOutput: (cb: (...a: unknown[]) => void) => listen('swarm:output', cb),
    onGraph: (cb: (...a: unknown[]) => void) => listen('swarm:graph', cb),
    onAgents: (cb: (...a: unknown[]) => void) => listen('swarm:agents', cb),
    onActivity: (cb: (...a: unknown[]) => void) => listen('swarm:activity', cb),
    onPlanPhase: (cb: (...a: unknown[]) => void) => listen('swarm:planPhase', cb),
    onPlanQueue: (cb: (...a: unknown[]) => void) => listen('swarm:planQueue', cb),
    onStopped: (cb: (...a: unknown[]) => void) => listen('swarm:stopped', cb),
  },

  // ── Shell ────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // ── Cleanup ──────────────────────────────────────────────────────────
  cleanup: (projectPath?: string) => ipcRenderer.invoke('window:cleanup', projectPath),
})
