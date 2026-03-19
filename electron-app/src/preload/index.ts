import { contextBridge, ipcRenderer } from 'electron'

export type BeadsTask = {
  id: string
  title: string
  status: string
  priority?: string
  tags: string[]
}

export type BeadsCheckResult =
  | { available: true }
  | { available: false; reason: string }

export type BeadsFetchResult =
  | { ok: true; tasks: BeadsTask[] }
  | { ok: false; error: string; tasks: [] }

contextBridge.exposeInMainWorld('ralph', {
  /** Open a native folder-picker dialog */
  selectProject: (): Promise<string | null> =>
    ipcRenderer.invoke('project:select'),

  beads: {
    /** Check if Beads is available in the given project folder */
    check: (projectPath: string): Promise<BeadsCheckResult> =>
      ipcRenderer.invoke('beads:check', projectPath),

    /**
     * Fetch tasks from `bd`.
     * @param filter  'open' | 'in_progress' | 'all'  (default 'open')
     */
    fetch: (projectPath: string, filter?: string): Promise<BeadsFetchResult> =>
      ipcRenderer.invoke('beads:fetch', projectPath, filter ?? 'open')
  },

  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('shell:openExternal', url)
  }
})

// Augment the global Window type for the renderer
declare global {
  interface Window {
    ralph: typeof window.ralph
  }
}
