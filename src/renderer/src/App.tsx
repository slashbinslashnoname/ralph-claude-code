import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { ActivityEvent, CircuitBreakerSnapshot } from './types/ipc'

// Page components
import Dashboard from './pages/Dashboard'
import BeadsPage from './pages/BeadsPage'
import SwarmPage from './pages/SwarmPage'
import LogViewer from './pages/LogViewer'
import ConfigEditor from './pages/ConfigEditor'
import PlanPage from './pages/PlanPage'
import MemoryPage from './pages/MemoryPage'
import SetupWizard from './pages/SetupWizard'
import SlashbotLogo from './components/SlashbotLogo'
import UpdateBanner from './components/UpdateBanner'

const sb = window.slashbot

type Page = 'dashboard' | 'beads' | 'swarm' | 'plan' | 'memory' | 'logs' | 'config' | 'setup'

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '\u25C9' },
  { id: 'plan', label: 'Plan', icon: '\u25B6' },
  { id: 'beads', label: 'Beads', icon: '\u29BE' },
  { id: 'swarm', label: 'Swarm', icon: '\u2B21' },
  { id: 'memory', label: 'Memory', icon: '\u{1F9E0}' },
  { id: 'logs', label: 'Logs', icon: '\u2630' },
  { id: 'config', label: 'Config', icon: '\u2699' },
]

interface TabState {
  path: string
  page: Page
  isEnabled: boolean
  circuits: Record<string, CircuitBreakerSnapshot>
}

// Global agent output + activity buffers (survive page navigation)
export const globalAgentOutputs: Record<string, string> = {}
const globalActivity: ActivityEvent[] = []

export default function App() {
  const [tabs, setTabs] = useState<TabState[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [recentProjects, setRecentProjects] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const persistRef = useRef(false)

  // Load saved tabs + recent projects on mount
  useEffect(() => {
    Promise.all([
      sb.activeProjectTabs(),
      sb.recentProjects(),
    ]).then(async ([saved, recent]) => {
      setRecentProjects(recent)
      if (saved.paths.length > 0) {
        setTabs(saved.paths.map(p => ({
          path: p,
          page: 'dashboard' as Page,
          isEnabled: false,
          circuits: {},
        })))
        setActiveIdx(Math.min(saved.active, saved.paths.length - 1))
      }
      setLoaded(true)
    })
  }, [])

  // Persist tabs whenever they change (skip initial load)
  useEffect(() => {
    if (!loaded) return
    if (!persistRef.current) { persistRef.current = true; return }
    sb.saveActiveProjectTabs({
      paths: tabs.map(t => t.path),
      active: activeIdx,
    })
  }, [tabs, activeIdx, loaded])

  // Check enabled state & read circuit for each tab
  useEffect(() => {
    if (!loaded) return
    tabs.forEach((tab, i) => {
      sb.isEnabled(tab.path).then(r => {
        setTabs(prev => {
          const next = [...prev]
          if (next[i]) {
            next[i] = { ...next[i], isEnabled: r.enabled }
            if (!r.enabled && next[i].page !== 'setup') next[i] = { ...next[i], page: 'setup' }
          }
          return next
        })
      })
      sb.subscribeProject(tab.path)
      sb.readStatus(tab.path).then(s => {
        setTabs(prev => {
          const next = [...prev]
          if (next[i]) {
            next[i] = { ...next[i], circuits: s.circuits ?? {} }
          }
          return next
        })
      })
    })
    return () => { tabs.forEach(t => sb.unsubscribeProject(t.path)) }
  }, [loaded, tabs.map(t => t.path).join('\0')])

  // Plan approval state (persists across navigation)
  const [pendingPlan, setPendingPlan] = useState<{ planMd: string; request: string } | null>(null)

  // Swarm output + activity state (lifted from SwarmPage so it persists across navigation)
  const [agentOutputs, setAgentOutputs] = useState<Record<string, string>>(globalAgentOutputs)
  const [swarmActivity, setSwarmActivity] = useState<ActivityEvent[]>(globalActivity)
  const outputFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outputDirty = useRef(false)

  // Live updates — these listeners stay alive regardless of which page is shown
  useEffect(() => {
    // Throttled flush: batch output updates to avoid rendering on every chunk
    const flushOutputs = () => {
      outputFlushTimer.current = null
      if (outputDirty.current) {
        outputDirty.current = false
        setAgentOutputs({ ...globalAgentOutputs })
      }
    }
    const scheduleFlush = () => {
      if (!outputFlushTimer.current) {
        outputFlushTimer.current = setTimeout(flushOutputs, 200)
      }
    }

    const unsubs = [
      sb.onCircuitUpdate((proj: string, c: CircuitBreakerSnapshot & { agentId?: string }) => {
        if (!c.agentId) return
        setTabs(prev => prev.map(t =>
          t.path === proj ? { ...t, circuits: { ...t.circuits, [c.agentId!]: c } } : t
        ))
      }),
      sb.swarm.onOutput((_p: string, agentId: string, chunk: string) => {
        globalAgentOutputs[agentId] = (globalAgentOutputs[agentId] ?? '').slice(-50000) + chunk
        outputDirty.current = true
        scheduleFlush()
      }),
      sb.swarm.onPlanThinking((_p: string, planMd: string, request: string) => {
        setPendingPlan({ planMd, request })
      }),
      sb.swarm.onPlanPhase((_p: string, phase: string) => {
        if (phase === 'done' || phase === '') setPendingPlan(null)
      }),
      sb.swarm.onActivity((_p: string, event: ActivityEvent) => {
        const key = `${event.ts}:${event.agentId}:${event.type}`
        const last = globalActivity.length > 0 ? globalActivity[globalActivity.length - 1] : null
        const lastKey = last ? `${last.ts}:${last.agentId}:${last.type}` : ''
        if (key !== lastKey) {
          globalActivity.push(event)
          if (globalActivity.length > 200) globalActivity.splice(0, globalActivity.length - 200)
          setSwarmActivity([...globalActivity])
        }
      }),
    ]
    return () => {
      unsubs.forEach(u => u())
      if (outputFlushTimer.current) clearTimeout(outputFlushTimer.current)
    }
  }, [])

  const addProject = useCallback(async (projectPath?: string) => {
    let p = projectPath
    if (!p) {
      p = await sb.selectProject() ?? undefined
      if (!p) return
    }
    // If already open, just switch to it
    const existingIdx = tabs.findIndex(t => t.path === p)
    if (existingIdx >= 0) {
      setActiveIdx(existingIdx)
      return
    }
    setRecentProjects(prev => [p!, ...prev.filter(x => x !== p)].slice(0, 10))
    const newTab: TabState = {
      path: p,
      page: 'dashboard',
      isEnabled: false,
      circuits: {},
    }
    setTabs(prev => [...prev, newTab])
    setActiveIdx(tabs.length)
  }, [tabs])

  const closeTab = useCallback((idx: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const closing = tabs[idx]
    if (closing) sb.unsubscribeProject(closing.path)
    setTabs(prev => prev.filter((_, i) => i !== idx))
    setActiveIdx(prev => {
      if (prev >= idx && prev > 0) return prev - 1
      return prev
    })
  }, [tabs])

  const setTabPage = useCallback((page: Page) => {
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, page } : t))
  }, [activeIdx])

  const setTabEnabled = useCallback((enabled: boolean) => {
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, isEnabled: enabled } : t))
  }, [activeIdx])

  if (!loaded) return null

  const current = tabs[activeIdx] ?? null

  // Empty state — no tabs open
  if (tabs.length === 0) {
    return (
      <>
      <UpdateBanner />
      <div className="landing">
        <div className="landing-content">
          <div className="landing-logo">
            <SlashbotLogo size={64} className="logo-icon" />
            <h1>Slashbot</h1>
            <p className="subtitle">Slashbot Swarm Orchestrator</p>
          </div>
          <button className="btn btn-primary btn-lg" onClick={() => addProject()}>
            Open Project
          </button>
          {recentProjects.length > 0 && (
            <div className="recent-projects">
              <h3>Recent</h3>
              {recentProjects.map(p => (
                <button key={p} className="btn btn-ghost recent-item" onClick={() => addProject(p)}>
                  <span className="folder-icon">{'\uD83D\uDCC1'}</span>
                  <span className="recent-path">{p.split('/').slice(-2).join('/')}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      </>
    )
  }

  return (
    <>
    <UpdateBanner />
    <div className="app-layout has-tabs">
      {/* Project tab bar */}
      <div className="project-tabs">
        <div className="project-tabs-scroll">
          {tabs.map((tab, i) => (
            <button
              key={tab.path}
              className={`project-tab ${i === activeIdx ? 'active' : ''}`}
              onClick={() => setActiveIdx(i)}
              title={tab.path}
            >
              <span className="project-tab-dot" />
              <span className="project-tab-name">{tab.path.split('/').pop()}</span>
              <span className="project-tab-close" onClick={(e) => closeTab(i, e)}>{'\u00D7'}</span>
            </button>
          ))}
          <button className="project-tab project-tab-add" onClick={() => addProject()} title="Open project">
            +
          </button>
        </div>
      </div>

      {/* Sidebar */}
      {current && (
        <nav className="sidebar">
          <div className="sidebar-brand">
            <SlashbotLogo size={22} className="brand-logo" />
            <span className="brand-name">Slashbot</span>
          </div>
          <div className="nav-items">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                className={`nav-item ${current.page === item.id ? 'active' : ''}`}
                onClick={() => setTabPage(item.id)}
                title={item.label}
                disabled={!current.isEnabled && item.id !== 'setup'}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* Main content */}
      {current && (
        <main className="main-content">
          {current.page === 'setup' && (
            <SetupWizard projectPath={current.path} onComplete={() => { setTabEnabled(true); setTabPage('dashboard') }} />
          )}
          {current.page === 'dashboard' && current.isEnabled && (
            <Dashboard projectPath={current.path} circuits={current.circuits} onNavigate={(p) => setTabPage(p as Page)} />
          )}
          {current.page === 'beads' && current.isEnabled && <BeadsPage projectPath={current.path} />}
          {current.page === 'swarm' && current.isEnabled && (
            <SwarmPage
              projectPath={current.path}
              agentOutputs={agentOutputs}
              setAgentOutputs={setAgentOutputs}
              activity={swarmActivity}
              setActivity={setSwarmActivity}
            />
          )}
          {current.page === 'plan' && current.isEnabled && (
            <PlanPage
              projectPath={current.path}
              pendingPlan={pendingPlan}
              setPendingPlan={setPendingPlan}
              agentOutputs={agentOutputs}
              setAgentOutputs={setAgentOutputs}
            />
          )}
          {current.page === 'memory' && current.isEnabled && <MemoryPage />}
          {current.page === 'logs' && current.isEnabled && <LogViewer projectPath={current.path} />}
          {current.page === 'config' && current.isEnabled && <ConfigEditor projectPath={current.path} />}
        </main>
      )}

      {/* Status bar */}
      {current && (
        <footer className="status-bar">
          {(() => {
            const states = Object.values(current.circuits).map(c => c.state)
            const hasOpen = states.includes('OPEN')
            const hasHalfOpen = states.includes('HALF_OPEN')
            if (hasOpen) return <span className="circuit-badge open">CB: OPEN</span>
            if (hasHalfOpen) return <span className="circuit-badge half_open">CB: HALF_OPEN</span>
            return null
          })()}
          <span className="status-spacer" />
          <span className="status-path">{current.path}</span>
        </footer>
      )}
    </div>
    </>
  )
}
