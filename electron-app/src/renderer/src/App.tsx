import React, { useCallback, useEffect, useRef, useState } from 'react'
import TabBar, { ProjectTab } from './components/TabBar'
import Dashboard    from './pages/Dashboard'
import BeadsViewer  from './pages/BeadsViewer'
import LogViewer    from './pages/LogViewer'
import ConfigEditor from './pages/ConfigEditor'
import TerminalPage from './pages/TerminalPage'

type Page = 'dashboard' | 'beads' | 'logs' | 'config' | 'terminal'

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '◉', label: 'Dashboard' },
  { id: 'beads',     icon: '◎', label: 'Beads Tasks' },
  { id: 'logs',      icon: '≡',  label: 'Logs' },
  { id: 'config',    icon: '⚙',  label: 'Config' },
  { id: 'terminal',  icon: '⌨',  label: 'Terminal' }
]

function genId(): string { return Math.random().toString(36).slice(2) }

export default function App(): JSX.Element {
  const [tabs,     setTabs]     = useState<ProjectTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [page,     setPage]     = useState<Page>('dashboard')
  // Track which projects are running (updated by ralph:exit / ralph:start)
  const runningRef = useRef<Set<string>>(new Set())

  const activeTab = tabs.find(t => t.id === activeId) ?? null

  // ── Load recent projects into tabs on startup ────────────────────────────
  useEffect(() => {
    window.ralph.recentProjects().then(recents => {
      if (recents.length === 0) return
      const initialTabs: ProjectTab[] = recents.slice(0, 5).map(p => ({
        id: genId(), path: p, name: p.split('/').pop() ?? p, running: false
      }))
      setTabs(initialTabs)
      setActiveId(initialTabs[0].id)
      initialTabs.forEach(t => window.ralph.subscribeStatus(t.path))
    })
  }, [])

  // ── Global IPC listeners ─────────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      window.ralph.onRalphExit((projectPath, _reason) => {
        runningRef.current.delete(projectPath)
        setTabs(ts => ts.map(t => t.path === projectPath ? { ...t, running: false } : t))
      }),
      // No onRalphStart event from main — we update running state in openProject / tabStart
    ]
    return () => unsubs.forEach(f => f())
  }, [])

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => () => { window.ralph.cleanup() }, [])

  // ── Tab management ───────────────────────────────────────────────────────

  const openProject = useCallback(async () => {
    const path = await window.ralph.selectProject()
    if (!path) return

    // Reuse existing tab if already open
    const existing = tabs.find(t => t.path === path)
    if (existing) { setActiveId(existing.id); return }

    const tab: ProjectTab = { id: genId(), path, name: path.split('/').pop() ?? path, running: false }
    setTabs(ts => [...ts, tab])
    setActiveId(tab.id)
    window.ralph.subscribeStatus(path)
  }, [tabs])

  const closeTab = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id)
    if (tab) {
      window.ralph.stopRalph(tab.path)
      window.ralph.unsubscribeStatus(tab.path)
      window.ralph.cleanup(tab.path)
    }
    setTabs(ts => {
      const remaining = ts.filter(t => t.id !== id)
      if (activeId === id) setActiveId(remaining[remaining.length - 1]?.id ?? null)
      return remaining
    })
  }, [tabs, activeId])

  const markRunning = useCallback((projectPath: string, running: boolean) => {
    setTabs(ts => ts.map(t => t.path === projectPath ? { ...t, running } : t))
  }, [])

  return (
    <div className="layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          Ralph<br />
          <span>for Claude Code</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(n => (
            <button
              key={n.id}
              className={`nav-item${page === n.id ? ' active' : ''}`}
              onClick={() => setPage(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border)', padding: '8px' }}>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={openProject}>
            ⊕ Open project…
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Tab bar */}
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={closeTab}
          onAdd={openProject}
        />

        {/* Page content */}
        <main className="main" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tabs.length === 0 ? (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-icon">📂</div>
              <div className="state-title">No projects open</div>
              <div className="state-desc">Click <strong>Open project…</strong> or the + tab to get started.</div>
              <button className="btn btn-primary" onClick={openProject}>⊕ Open project</button>
            </div>
          ) : !activeTab ? (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-desc">Select a tab above.</div>
            </div>
          ) : (
            // Render all tabs but only show the active one (preserves state)
            tabs.map(tab => (
              <div
                key={tab.id}
                style={{ display: tab.id === activeId ? 'contents' : 'none' }}
              >
                {page === 'dashboard' && <Dashboard    projectPath={tab.path} onRunningChange={r => markRunning(tab.path, r)} />}
                {page === 'beads'     && <BeadsViewer  projectPath={tab.path} />}
                {page === 'logs'      && <LogViewer    projectPath={tab.path} />}
                {page === 'config'    && <ConfigEditor projectPath={tab.path} />}
                {page === 'terminal'  && <TerminalPage projectPath={tab.path} onRunningChange={r => markRunning(tab.path, r)} />}
              </div>
            ))
          )}
        </main>
      </div>
    </div>
  )
}
