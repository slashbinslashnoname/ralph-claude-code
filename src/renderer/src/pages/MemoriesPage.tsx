import React, { useState, useEffect, useCallback } from 'react'
import { useToast } from '../components/Toast'
import type { BdMemory } from '../types/ipc'

const sb = window.slashbot

interface Props { projectPath: string }

function MemoryCard({ memory, onDelete }: { memory: BdMemory; onDelete: (key: string) => void }) {
  return (
    <div className="memory-card">
      <div className="memory-card-header">
        <span className="memory-key" title={memory.key}>{memory.key}</span>
        <button className="btn btn-sm btn-danger" onClick={() => onDelete(memory.key)}>Delete</button>
      </div>
      <div className="memory-text">{memory.text}</div>
    </div>
  )
}

export default function MemoriesPage({ projectPath }: Props) {
  const { showToast } = useToast()
  const [memories, setMemories] = useState<BdMemory[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newText, setNewText] = useState('')
  const [newKey, setNewKey] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await sb.memories.list(projectPath)
      if (r.ok) setMemories(r.memories)
      else showToast(`Failed to load memories: ${r.error}`, 'error')
    } catch (e) {
      showToast(`Error loading memories: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
    setLoading(false)
  }, [projectPath, showToast])

  useEffect(() => { refresh() }, [refresh])

  const handleAdd = useCallback(async () => {
    if (!newText.trim()) return
    try {
      const r = await sb.memories.add(projectPath, newText.trim(), newKey.trim() || undefined)
      if (r.ok) {
        showToast('Memory added', 'success')
        setNewText('')
        setNewKey('')
        setShowAdd(false)
        refresh()
      } else {
        showToast(`Failed to add memory: ${r.error}`, 'error')
      }
    } catch (e) {
      showToast(`Error adding memory: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [projectPath, newText, newKey, showToast, refresh])

  const handleDelete = useCallback(async (key: string) => {
    try {
      const r = await sb.memories.forget(projectPath, key)
      if (r.ok) {
        showToast('Memory deleted', 'success')
        refresh()
      } else {
        showToast(`Failed to delete memory: ${r.error}`, 'error')
      }
    } catch (e) {
      showToast(`Error deleting memory: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [projectPath, showToast, refresh])

  const filtered = search.trim()
    ? memories.filter(m =>
        m.key.toLowerCase().includes(search.toLowerCase()) ||
        m.text.toLowerCase().includes(search.toLowerCase())
      )
    : memories

  return (
    <div className="page memories-page">
      <header className="page-header">
        <h2>Memories</h2>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => {
            if (showAdd) { setNewText(''); setNewKey('') }
            setShowAdd(!showAdd)
          }}>
            {showAdd ? 'Cancel' : 'Add Memory'}
          </button>
          <button className="btn btn-ghost" onClick={refresh} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {showAdd && (
        <div className="memory-add-form">
          <input
            type="text"
            className="input"
            placeholder="Key (optional)"
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
          />
          <textarea
            className="input textarea"
            placeholder="Memory text"
            value={newText}
            onChange={e => setNewText(e.target.value)}
            rows={3}
          />
          <button className="btn btn-primary" onClick={handleAdd} disabled={!newText.trim()}>
            Save
          </button>
        </div>
      )}

      <div className="memory-search">
        <input
          type="text"
          className="input"
          placeholder="Search memories..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading && <div className="loading">Loading...</div>}

      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          {search ? 'No memories match your search.' : 'No memories yet.'}
        </div>
      )}

      <div className="memory-list">
        {filtered.map(m => (
          <MemoryCard key={m.key} memory={m} onDelete={handleDelete} />
        ))}
      </div>
    </div>
  )
}
