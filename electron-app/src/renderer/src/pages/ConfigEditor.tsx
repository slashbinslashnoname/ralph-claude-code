import React, { useCallback, useEffect, useState } from 'react'

type Tab = { id: string; label: string; path: string; lang: string }

const TABS: Tab[] = [
  { id: 'ralphrc',   label: '.ralphrc',     path: '.ralphrc',          lang: 'bash' },
  { id: 'prompt',   label: 'PROMPT.md',    path: '.ralph/PROMPT.md',  lang: 'markdown' },
  { id: 'fixplan',  label: 'fix_plan.md',  path: '.ralph/fix_plan.md', lang: 'markdown' },
  { id: 'agent',    label: 'AGENT.md',     path: '.ralph/AGENT.md',   lang: 'markdown' }
]

function TaskCheckbox({ line, onChange }: { line: string; onChange: (updated: string) => void }): JSX.Element {
  const checked = line.startsWith('- [x]') || line.startsWith('- [X]')
  const isTask = line.startsWith('- [')

  if (!isTask) return <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.8 }}>{line}</div>

  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', lineHeight: 1.8 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => {
          const rest = line.replace(/^- \[[xX ]\]\s*/, '')
          onChange(`- [${e.target.checked ? 'x' : ' '}] ${rest}`)
        }}
        style={{ marginTop: 4, accentColor: 'var(--accent)' }}
      />
      <span style={{
        fontSize: 13,
        textDecoration: checked ? 'line-through' : 'none',
        color: checked ? 'var(--muted)' : 'var(--text)'
      }}>
        {line.replace(/^- \[[xX ]\]\s*/, '')}
      </span>
    </label>
  )
}

function FixPlanViewer({ content, onChange }: { content: string; onChange: (c: string) => void }): JSX.Element {
  const lines = content.split('\n')
  const updateLine = (i: number, updated: string): void => {
    const newLines = [...lines]
    newLines[i] = updated
    onChange(newLines.join('\n'))
  }
  const total = lines.filter(l => l.startsWith('- [')).length
  const done  = lines.filter(l => l.startsWith('- [x]') || l.startsWith('- [X]')).length

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
      {total > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            <span>Progress</span><span>{done} / {total} tasks</span>
          </div>
          <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 99 }}>
            <div style={{ height: '100%', width: `${total > 0 ? (done / total) * 100 : 0}%`, background: 'var(--green)', borderRadius: 99, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
      {lines.map((line, i) => (
        <TaskCheckbox key={i} line={line} onChange={updated => updateLine(i, updated)} />
      ))}
    </div>
  )
}

export default function ConfigEditor({ projectPath }: { projectPath: string | null }): JSX.Element {
  const [activeTab, setActiveTab] = useState<string>('ralphrc')
  const [contents, setContents]   = useState<Record<string, string>>({})
  const [dirty, setDirty]         = useState<Record<string, boolean>>({})
  const [saving, setSaving]       = useState(false)
  const [msg, setMsg]             = useState<string | null>(null)

  const flash = (m: string): void => { setMsg(m); setTimeout(() => setMsg(null), 3000) }

  const loadTab = useCallback(async (tab: Tab): Promise<void> => {
    if (!projectPath || contents[tab.id] !== undefined) return
    const r = await window.ralph.readFile(projectPath, tab.path)
    if (r.ok && r.content !== undefined) {
      setContents(prev => ({ ...prev, [tab.id]: r.content! }))
    } else {
      setContents(prev => ({ ...prev, [tab.id]: `# File not found: ${tab.path}` }))
    }
  }, [projectPath, contents])

  // Load first tab on mount and when project changes
  useEffect(() => {
    setContents({})
    setDirty({})
  }, [projectPath])

  useEffect(() => {
    const tab = TABS.find(t => t.id === activeTab)
    if (tab) loadTab(tab)
  }, [activeTab, loadTab])

  // Subscribe to live fix_plan changes
  useEffect(() => {
    if (!projectPath) return
    window.ralph.subscribeStatus(projectPath)
    const unsub = window.ralph.onFixplanUpdate(content => {
      if (!dirty['fixplan']) setContents(prev => ({ ...prev, fixplan: content }))
    })
    return () => { unsub(); window.ralph.unsubscribeStatus() }
  }, [projectPath, dirty])

  const handleChange = (id: string, value: string): void => {
    setContents(prev => ({ ...prev, [id]: value }))
    setDirty(prev => ({ ...prev, [id]: true }))
  }

  const save = async (): Promise<void> => {
    if (!projectPath) return
    setSaving(true)
    const tab = TABS.find(t => t.id === activeTab)!
    const r = await window.ralph.writeFile(projectPath, tab.path, contents[activeTab] ?? '')
    setSaving(false)
    if (r.ok) {
      setDirty(prev => ({ ...prev, [activeTab]: false }))
      flash('Saved')
    } else {
      flash(`Error: ${r.error}`)
    }
  }

  if (!projectPath) {
    return (
      <div className="state-box" style={{ flex: 1 }}>
        <div className="state-icon">⚙</div>
        <div className="state-title">No project open</div>
      </div>
    )
  }

  const content = contents[activeTab]
  const isDirty = dirty[activeTab]
  const isFixplan = activeTab === 'fixplan'

  return (
    <>
      <div className="page-header">
        <div className="page-title">⚙ Config Editor</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isDirty && (
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null} Save
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div style={{ padding: '6px 24px', background: 'var(--surface2)', fontSize: 12, color: 'var(--accent)', borderBottom: '1px solid var(--border)' }}>
          {msg}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 20px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--muted)',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent'
            }}
          >
            {tab.label}{dirty[tab.id] ? ' ●' : ''}
          </button>
        ))}
      </div>

      {content === undefined ? (
        <div className="state-box" style={{ flex: 1 }}><span className="spinner" /></div>
      ) : isFixplan ? (
        <FixPlanViewer
          content={content}
          onChange={v => handleChange('fixplan', v)}
        />
      ) : (
        <textarea
          value={content}
          onChange={e => handleChange(activeTab, e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, width: '100%', padding: '20px 24px',
            background: 'var(--bg)', color: 'var(--text)',
            fontFamily: 'monospace', fontSize: 13, lineHeight: 1.7,
            border: 'none', outline: 'none', resize: 'none'
          }}
        />
      )}

      <div className="summary-bar">
        {TABS.find(t => t.id === activeTab)?.path}
        {isDirty ? ' · unsaved changes' : ''}
        {isFixplan && (() => {
          const lines = (content ?? '').split('\n')
          const done = lines.filter(l => l.startsWith('- [x]') || l.startsWith('- [X]')).length
          const total = lines.filter(l => l.startsWith('- [')).length
          return total > 0 ? ` · ${done}/${total} tasks done` : ''
        })()}
      </div>
    </>
  )
}
