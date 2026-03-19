import React, { useCallback, useEffect, useState } from 'react'

type Tab = { id: string; label: string; path: string; lang: string }

const TABS: Tab[] = [
  { id: 'ralphrc', label: '.ralphrc',    path: '.ralphrc',         lang: 'bash' },
  { id: 'prompt',  label: 'PROMPT.md',  path: '.ralph/PROMPT.md', lang: 'markdown' },
  { id: 'agent',   label: 'AGENT.md',   path: '.ralph/AGENT.md',  lang: 'markdown' }
]

export default function ConfigEditor({ projectPath }: { projectPath: string }): JSX.Element {
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

  useEffect(() => {
    setContents({})
    setDirty({})
  }, [projectPath])

  useEffect(() => {
    const tab = TABS.find(t => t.id === activeTab)
    if (tab) loadTab(tab)
  }, [activeTab, loadTab])

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

  const content = contents[activeTab]
  const isDirty = dirty[activeTab]

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
      </div>
    </>
  )
}
