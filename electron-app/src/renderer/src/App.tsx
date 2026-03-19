import React, { useCallback, useEffect, useRef, useState } from 'react'
import TabBar, { ProjectTab } from './components/TabBar'
import Dashboard    from './pages/Dashboard'
import BeadsViewer  from './pages/BeadsViewer'
import LogViewer    from './pages/LogViewer'
import ConfigEditor from './pages/ConfigEditor'
import TerminalPage from './pages/TerminalPage'
import SetupWizard  from './pages/SetupWizard'

type Page = 'dashboard' | 'beads' | 'logs' | 'config' | 'terminal' | 'setup'

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '◉', label: 'Dashboard' },
  { id: 'beads',     icon: '◎', label: 'Beads Tasks' },
  { id: 'logs',      icon: '≡',  label: 'Logs' },
  { id: 'config',    icon: '⚙',  label: 'Config' },
  { id: 'terminal',  icon: '⌨',  label: 'Terminal' },
  { id: 'setup',     icon: '✦',  label: 'Setup' }
]

function genId(): string { return Math.random().toString(36).slice(2) }

// Per-tab state that App manages
interface TabMeta extends ProjectTab {
  enabled: boolean  // whether Ralph is enabled in this project
}

export default function App(): JSX.Element {
  const [tabs,     setTabs]     = useState<TabMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [page,     setPage]     = useState<Page>('dashboard')
  const runningRef = useRef<Set<string>>(new Set())

  const activeTab = tabs.find(t => t.id === activeId) ?? null

  // ── Load recent projects on startup ─────────────────────────────────────
  useEffect(() => {
    window.ralph.recentProjects().then(async (recents: string[]) => {
      if (recents.length === 0) return
      const newTabs: TabMeta[] = await Promise.all(
        recents.slice(0, 5).map(async p => {
          const s = await window.ralph.isEnabled(p) as { enabled: boolean }
          return { id: genId(), path: p, name: p.split('/').pop() ?? p, running: false, enabled: s.enabled }
        })
      )
      setTabs(newTabs)
      setActiveId(newTabs[0].id)
      newTabs.forEach(t => window.ralph.subscribeStatus(t.path))
      // Auto-navigate to setup if first project isn't enabled
      if (!newTabs[0].enabled) setPage('setup')
    })
  }, [])

  // ── Global push listeners ─────────────────────────────────────────────────
  useEffect(() => {
    const unsub = window.ralph.onRalphExit((projectPath: string) => {
      runningRef.current.delete(projectPath)
      setTabs(ts => ts.map(t => t.path === projectPath ? { ...t, running: false } : t))
    })
    return () => unsub()
  }, [])

  useEffect(() => () => { window.ralph.cleanup() }, [])

  // ── Tab management ────────────────────────────────────────────────────────

  const openProject = useCallback(async () => {
    const path = await window.ralph.selectProject()
    if (!path) return

    const existing = tabs.find(t => t.path === path)
    if (existing) { setActiveId(existing.id); return }

    const s = await window.ralph.isEnabled(path) as { enabled: boolean }
    const tab: TabMeta = {
      id: genId(), path, name: path.split('/').pop() ?? path,
      running: false, enabled: s.enabled
    }
    setTabs(ts => [...ts, tab])
    setActiveId(tab.id)
    window.ralph.subscribeStatus(path)
    // Auto-navigate to setup if not enabled
    if (!s.enabled) setPage('setup')
    else setPage('dashboard')
  }, [tabs])

  const closeTab = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id)
    if (tab) {
      window.ralph.stopRalph(tab.path)
      window.ralph.unsubscribeStatus(tab.path)
      window.ralph.cleanup(tab.path)
    }
    setTabs(ts => {
      const rest = ts.filter(t => t.id !== id)
      if (activeId === id) setActiveId(rest[rest.length - 1]?.id ?? null)
      return rest
    })
  }, [tabs, activeId])

  const markRunning = useCallback((projectPath: string, running: boolean) => {
    setTabs(ts => ts.map(t => t.path === projectPath ? { ...t, running } : t))
  }, [])

  // Called when SetupWizard completes
  const handleSetupDone = useCallback(() => {
    if (activeTab) {
      setTabs(ts => ts.map(t => t.id === activeTab.id ? { ...t, enabled: true } : t))
    }
    setPage('dashboard')
  }, [activeTab])

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
              {/* Badge: warn when Setup needed */}
              {n.id === 'setup' && activeTab && !activeTab.enabled && (
                <span style={{
                  marginLeft: 'auto', background: 'var(--yellow)',
                  color: '#000', fontSize: 10, fontWeight: 700,
                  padding: '1px 5px', borderRadius: 99
                }}>!</span>
              )}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border)', padding: '8px' }}>
          <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={openProject}>
            ⊕ Open project…
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={closeTab}
          onAdd={openProject}
        />

        <main className="main" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tabs.length === 0 ? (
            <div className="state-box" style={{ flex: 1 }}>
              <div className="state-icon">📂</div>
              <div className="state-title">No projects open</div>
              <div className="state-desc">Open a folder to get started. Ralph will detect the project type and help you set it up.</div>
              <button className="btn btn-primary" onClick={openProject}>⊕ Open project</button>
            </div>
          ) : !activeTab ? null : (
            tabs.map(tab => (
              <div key={tab.id} style={{ display: tab.id === activeId ? 'contents' : 'none' }}>
                {/* If not enabled and not on setup page, show banner */}
                {!tab.enabled && page !== 'setup' && (
                  <div style={{
                    padding: '8px 24px', background: '#3b2b00',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 12, fontSize: 13
                  }}>
                    <span style={{ color: 'var(--yellow)' }}>⚠ Ralph is not set up in this project.</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setPage('setup')}>
                      Run Setup →
                    </button>
                  </div>
                )}

                {page === 'setup'     && <SetupWizard  projectPath={tab.path} onComplete={handleSetupDone} />}
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
