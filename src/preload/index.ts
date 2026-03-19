import { contextBridge, ipcRenderer } from 'electron'

// All IPC channels are projectPath-scoped.
// Push events include projectPath as first arg so multi-tab routing works.

contextBridge.exposeInMainWorld('ralph', {
  // ── Project management ──────────────────────────────────────────────────
  selectProject:  (): Promise<string | null>   => ipcRenderer.invoke('project:select'),
  recentProjects: (): Promise<string[]>         => ipcRenderer.invoke('project:recent'),
  addProject:     (p: string): Promise<boolean> => ipcRenderer.invoke('project:add', p),

  // ── Ralph enable (replaces ralph_enable.sh) ─────────────────────────────
  isEnabled: (projectPath: string) =>
    ipcRenderer.invoke('ralph:is-enabled', projectPath),
  enable: (projectPath: string, opts: unknown) =>
    ipcRenderer.invoke('ralph:enable', projectPath, opts),

  // ── Status snapshot (one-shot) ──────────────────────────────────────────
  readStatus: (projectPath: string) => ipcRenderer.invoke('status:read', projectPath),

  // ── Live file-change subscriptions ─────────────────────────────────────
  subscribeStatus:   (projectPath: string) => ipcRenderer.invoke('status:subscribe', projectPath),
  unsubscribeStatus: (projectPath: string) => ipcRenderer.invoke('status:unsubscribe', projectPath),

  // Push callbacks — all include projectPath as first arg
  onStatusUpdate:   (cb: (p: string, d: unknown) => void) => listen('status:update',  cb),
  onProgressUpdate: (cb: (p: string, d: unknown) => void) => listen('progress:update', cb),
  onCircuitUpdate:  (cb: (p: string, d: unknown) => void) => listen('circuit:update',  cb),
  onAnalysisUpdate: (cb: (p: string, d: unknown) => void) => listen('analysis:update', cb),
  onFixplanUpdate:  (cb: (p: string, c: string)  => void) => listen('fixplan:update',  cb),
  onLogLines:       (cb: (p: string, lines: string[]) => void) => listen('logs:lines', cb),
  onRalphExit:      (cb: (p: string, reason: string, detail?: string) => void) => listen('ralph:exit', cb),
  onPtyData:        (cb: (p: string, chunk: string) => void) => listen('pty:data',    cb),

  // ── Logs ────────────────────────────────────────────────────────────────
  readLogs: (projectPath: string, lines?: number): Promise<string[]> =>
    ipcRenderer.invoke('logs:read', projectPath, lines),
  listLogs: (projectPath: string): Promise<string[]> =>
    ipcRenderer.invoke('logs:list', projectPath),

  // ── File editor ─────────────────────────────────────────────────────────
  readFile:  (projectPath: string, relPath: string) =>
    ipcRenderer.invoke('file:read', projectPath, relPath),
  writeFile: (projectPath: string, relPath: string, content: string) =>
    ipcRenderer.invoke('file:write', projectPath, relPath, content),

  // ── Ralph loop (TS engine) ───────────────────────────────────────────────
  startRalph:   (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ralph:start', projectPath),
  stopRalph:    (projectPath: string): Promise<void> =>
    ipcRenderer.invoke('ralph:stop', projectPath),
  ralphRunning: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke('ralph:running', projectPath),

  // ── Terminal output (Claude stdout forwarded via pty:data) ───────────────
  ptyWrite:  (projectPath: string, data: string): Promise<void> =>
    ipcRenderer.invoke('pty:write', projectPath, data),
  ptyResize: (cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', cols, rows),

  // ── Circuit breaker & session ────────────────────────────────────────────
  resetCircuit: (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('circuit:reset', projectPath),
  resetSession: (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('session:reset', projectPath),

  // ── Fix plan task injection ──────────────────────────────────────────────
  addTask: (projectPath: string, task: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fixplan:add-task', projectPath, task),

  // ── Beads ────────────────────────────────────────────────────────────────
  beads: {
    check: (projectPath: string) => ipcRenderer.invoke('beads:check', projectPath),
    fetch: (projectPath: string, filter?: string) =>
      ipcRenderer.invoke('beads:fetch', projectPath, filter ?? 'open')
  },

  // ── Swarm orchestrator ────────────────────────────────────────────────────
  swarm: {
    inject:  (projectPath: string, request: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('swarm:inject', projectPath, request),
    start:   (projectPath: string, workerCount?: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('swarm:start', projectPath, workerCount ?? 2),
    stop:    (projectPath: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('swarm:stop', projectPath),
    status:  (projectPath: string) => ipcRenderer.invoke('swarm:status', projectPath),
    graph:   (projectPath: string) => ipcRenderer.invoke('swarm:graph', projectPath),
    mail:    (projectPath: string, limit?: number) =>
      ipcRenderer.invoke('swarm:mail', projectPath, limit ?? 50),
    onLog:       (cb: (p: string, level: string, msg: string, agentId: string | null) => void) =>
      listen('swarm:log', cb),
    onOutput:    (cb: (p: string, agentId: string, chunk: string) => void) =>
      listen('swarm:output', cb),
    onGraph:     (cb: (p: string, stats: unknown, graph: unknown) => void) =>
      listen('swarm:graph', cb),
    onAgents:    (cb: (p: string, agents: unknown[]) => void) =>
      listen('swarm:agents', cb),
    onMail:      (cb: (p: string, msg: unknown) => void) =>
      listen('swarm:mail', cb),
    onPlanPhase: (cb: (p: string, phase: string) => void) =>
      listen('swarm:planPhase', cb),
    onStopped:   (cb: (p: string) => void) =>
      listen('swarm:stopped', cb),
  },

  // ── Shell ────────────────────────────────────────────────────────────────
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },

  // ── Cleanup ──────────────────────────────────────────────────────────────
  cleanup: (projectPath?: string): Promise<void> =>
    ipcRenderer.invoke('window:cleanup', projectPath)
})

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, ...args: T): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
