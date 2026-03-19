import React, { useCallback, useEffect, useState } from 'react'
import BeadsViewer  from './pages/BeadsViewer'
import Dashboard    from './pages/Dashboard'
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

export default function App(): JSX.Element {
  const [page, setPage]               = useState<Page>('dashboard')
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [recents, setRecents]         = useState<string[]>([])

  const loadRecents = useCallback(async () => {
    const list = await window.ralph.recentProjects()
    setRecents(list)
  }, [])

  useEffect(() => { loadRecents() }, [loadRecents])

  const openProject = useCallback(async () => {
    const p = await window.ralph.selectProject()
    if (p) { setProjectPath(p); loadRecents() }
  }, [loadRecents])

  const switchProject = (p: string): void => setProjectPath(p)

  // Clean up watchers/PTY on unmount
  useEffect(() => () => { window.ralph.cleanup() }, [])

  const projectName = projectPath ? projectPath.split('/').pop() ?? projectPath : null

  return (
    <div className="layout">
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

        {/* Project picker */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border)', padding: '8px 0' }}>
          <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Project
          </div>
          {projectPath && (
            <div style={{ padding: '4px 16px 6px', fontSize: 12, color: 'var(--accent)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {projectName}
            </div>
          )}
          <div className="project-list">
            {recents.filter(r => r !== projectPath).slice(0, 5).map(r => (
              <button key={r} className="project-item" title={r} onClick={() => switchProject(r)}>
                {r.split('/').pop()}
              </button>
            ))}
          </div>
          <div style={{ padding: '4px 8px' }}>
            <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={openProject}>
              ⊕ Open project…
            </button>
          </div>
        </div>
      </aside>

      <main className="main" style={{ display: 'flex', flexDirection: 'column' }}>
        {page === 'dashboard' && <Dashboard    projectPath={projectPath} />}
        {page === 'beads'     && <BeadsViewer  projectPath={projectPath} />}
        {page === 'logs'      && <LogViewer    projectPath={projectPath} />}
        {page === 'config'    && <ConfigEditor projectPath={projectPath} />}
        {page === 'terminal'  && <TerminalPage projectPath={projectPath} />}
      </main>
    </div>
  )
}
