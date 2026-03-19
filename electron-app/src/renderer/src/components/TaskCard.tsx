import React from 'react'

type BeadsTask = {
  id: string
  title: string
  status: string
  priority?: string
  tags: string[]
}

const STATUS_LABEL: Record<string, string> = {
  open:        'Open',
  in_progress: 'In Progress',
  closed:      'Closed'
}

export default function TaskCard({ task }: { task: BeadsTask }): JSX.Element {
  const statusClass = `status status-${task.status}`

  return (
    <div className="task-card">
      <span className="task-id">{task.id}</span>
      <div className="task-body">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">
          <span className={statusClass}>{STATUS_LABEL[task.status] ?? task.status}</span>
          {task.priority && (
            <span className="tag">P{task.priority}</span>
          )}
          {task.tags.map(tag => (
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
