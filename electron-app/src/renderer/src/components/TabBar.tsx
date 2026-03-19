import React from 'react'

export type ProjectTab = {
  id: string        // stable uuid
  path: string      // absolute path
  name: string      // basename
  running: boolean
}

interface TabBarProps {
  tabs: ProjectTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose:  (id: string) => void
  onAdd:    () => void
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onAdd }: TabBarProps): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', height: 38,
      background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      overflowX: 'auto', flexShrink: 0
    }}>
      {tabs.map(tab => (
        <div
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '0 14px', cursor: 'pointer', flexShrink: 0,
            borderRight: '1px solid var(--border)',
            background: activeId === tab.id ? 'var(--bg)' : 'transparent',
            borderBottom: activeId === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
            color: activeId === tab.id ? 'var(--text)' : 'var(--muted)',
            fontSize: 13, fontWeight: 500,
            transition: 'background 0.1s, color 0.1s', maxWidth: 200, minWidth: 100
          }}
        >
          {/* Running indicator */}
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: tab.running ? 'var(--green)' : 'var(--border)',
            boxShadow: tab.running ? '0 0 4px var(--green)' : 'none'
          }} />

          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {tab.name}
          </span>

          {/* Close button */}
          <button
            onClick={e => { e.stopPropagation(); onClose(tab.id) }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', fontSize: 14, lineHeight: 1,
              padding: '0 2px', flexShrink: 0, opacity: 0.6
            }}
            title={`Close ${tab.name}`}
          >
            ×
          </button>
        </div>
      ))}

      {/* Add tab */}
      <button
        onClick={onAdd}
        title="Open project"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '0 14px', color: 'var(--muted)', fontSize: 18,
          lineHeight: 1, flexShrink: 0
        }}
      >
        +
      </button>
    </div>
  )
}
