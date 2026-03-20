import React, { useState, useEffect, useCallback } from 'react'

const sb = window.slashbot

interface Props { projectPath: string }

const EDITABLE_FILES = [
  { path: '.slashbotrc', label: 'Configuration (.slashbotrc)' },
  { path: '.slashbot/PROMPT.md', label: 'Prompt (PROMPT.md)' },
  { path: '.slashbot/AGENT.md', label: 'Agent (AGENT.md)' },
]

export default function ConfigEditor({ projectPath }: Props) {
  const [activeFile, setActiveFile] = useState('.slashbotrc')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    sb.readFile(projectPath, activeFile).then(r => {
      if (r.ok) { setContent(r.content!); setSaved(true); setError('') }
      else setError(r.error ?? 'Failed to read file')
    })
  }, [projectPath, activeFile])

  const save = useCallback(async () => {
    const r = await sb.writeFile(projectPath, activeFile, content)
    if (r.ok) { setSaved(true); setError('') }
    else setError(r.error ?? 'Failed to save')
  }, [projectPath, activeFile, content])

  return (
    <div className="page">
      <header className="page-header">
        <h2>Configuration</h2>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={save} disabled={saved}>
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </header>
      <div className="config-tabs">
        {EDITABLE_FILES.map(f => (
          <button key={f.path} className={`tab ${activeFile === f.path ? 'active' : ''}`}
            onClick={() => setActiveFile(f.path)}>
            {f.label}
          </button>
        ))}
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      <textarea
        className="code-editor"
        value={content}
        onChange={e => { setContent(e.target.value); setSaved(false) }}
        onKeyDown={e => { if (e.key === 's' && e.metaKey) { e.preventDefault(); save() } }}
        spellCheck={false}
      />
    </div>
  )
}
