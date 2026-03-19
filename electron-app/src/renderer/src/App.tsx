import React, { useState } from 'react'
import BeadsViewer from './pages/BeadsViewer'

type Page = 'beads' | 'dashboard' | 'logs' | 'config'

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '◉', label: 'Dashboard' },
  { id: 'beads',     icon: '◎', label: 'Beads Tasks' },
  { id: 'logs',      icon: '≡',  label: 'Logs' },
  { id: 'config',    icon: '⚙',  label: 'Config' }
]

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('beads')

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
      </aside>

      <main className="main">
        {page === 'beads'     && <BeadsViewer />}
        {page === 'dashboard' && <Placeholder title="Dashboard" desc="Coming soon — real-time loop status, quota, and circuit breaker." />}
        {page === 'logs'      && <Placeholder title="Log Viewer" desc="Coming soon — streaming Ralph loop logs." />}
        {page === 'config'    && <Placeholder title="Config Editor" desc="Coming soon — edit .ralphrc, PROMPT.md and fix_plan.md." />}
      </main>
    </div>
  )
}

function Placeholder({ title, desc }: { title: string; desc: string }): JSX.Element {
  return (
    <div className="state-box" style={{ flex: 1 }}>
      <div className="state-icon">🚧</div>
      <div className="state-title">{title}</div>
      <div className="state-desc">{desc}</div>
    </div>
  )
}
