import { contextBridge, ipcRenderer } from 'electron'

// ── All IPC channels are now projectPath-scoped ──────────────────────────────
// Push events include projectPath as first arg so the renderer can route them.

contextBridge.exposeInMainWorld('ralph', {
  // ── Project management ────────────────────────────────────────────────
  selectProject:  (): Promise<string | null>   => ipcRenderer.invoke('project:select'),
  recentProjects: (): Promise<string[]>         => ipcRenderer.invoke('project:recent'),
  addProject:     (p: string): Promise<boolean> => ipcRenderer.invoke('project:add', p),

  // ── Status snapshot (one-shot) ────────────────────────────────────────
  readStatus: (projectPath: string) => ipcRenderer.invoke('status:read', projectPath),

  // ── File watchers (live push) ─────────────────────────────────────────
  subscribeStatus:   (projectPath: string) => ipcRenderer.invoke('status:subscribe', projectPath),
  unsubscribeStatus: (projectPath: string) => ipcRenderer.invoke('status:unsubscribe', projectPath),

  // Listeners receive (projectPath, data) so multi-tab can route correctly
  onStatusUpdate:   (cb: (p: string, d: unknown) => void) => listen('status:update',   cb),
  onProgressUpdate: (cb: (p: string, d: unknown) => void) => listen('progress:update',  cb),
  onCircuitUpdate:  (cb: (p: string, d: unknown) => void) => listen('circuit:update',   cb),
  onAnalysisUpdate: (cb: (p: string, d: unknown) => void) => listen('analysis:update',  cb),
  onFixplanUpdate:  (cb: (p: string, c: string)  => void) => listen('fixplan:update',   cb),
  onLogLines:       (cb: (p: string, lines: string[]) => void) => listen('logs:lines',  cb),
  onRalphExit:      (cb: (p: string, reason: string, detail?: string) => void) => listen('ralph:exit', cb),
  onPtyData:        (cb: (p: string, chunk: string) => void) => listen('pty:data',      cb),

  // ── Logs ──────────────────────────────────────────────────────────────
  readLogs: (projectPath: string, lines?: number): Promise<string[]> =>
    ipcRenderer.invoke('logs:read', projectPath, lines),
  listLogs: (projectPath: string): Promise<string[]> =>
    ipcRenderer.invoke('logs:list', projectPath),

  // ── File editor ───────────────────────────────────────────────────────
  readFile:  (projectPath: string, relPath: string) =>
    ipcRenderer.invoke('file:read', projectPath, relPath),
  writeFile: (projectPath: string, relPath: string, content: string) =>
    ipcRenderer.invoke('file:write', projectPath, relPath, content),

  // ── Ralph loop ────────────────────────────────────────────────────────
  startRalph:   (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ralph:start', projectPath),
  stopRalph:    (projectPath: string): Promise<void> =>
    ipcRenderer.invoke('ralph:stop', projectPath),
  ralphRunning: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke('ralph:running', projectPath),

  // ── Terminal output (PTY shim — loop output forwarded as pty:data) ────
  ptyWrite:  (projectPath: string, data: string): Promise<void> =>
    ipcRenderer.invoke('pty:write', projectPath, data),
  ptyResize: (cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', cols, rows),

  // ── Circuit breaker ───────────────────────────────────────────────────
  resetCircuit: (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('circuit:reset', projectPath),
  resetSession: (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('session:reset', projectPath),

  // ── Beads ─────────────────────────────────────────────────────────────
  beads: {
    check: (projectPath: string) => ipcRenderer.invoke('beads:check', projectPath),
    fetch: (projectPath: string, filter?: string) => ipcRenderer.invoke('beads:fetch', projectPath, filter ?? 'open')
  },

  // ── Shell ─────────────────────────────────────────────────────────────
  shell: { openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url) },

  // ── Cleanup ───────────────────────────────────────────────────────────
  cleanup: (projectPath?: string): Promise<void> => ipcRenderer.invoke('window:cleanup', projectPath)
})

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, ...args: T): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
