import type { ReactNode } from 'react'

export interface EmptyStateAction {
  /** Button label */
  label: string
  /** Click handler */
  onClick: () => void
}

export interface EmptyStateProps {
  /** Icon character or emoji displayed above the message */
  icon?: string
  /** Primary heading text */
  title: string
  /** Optional description below the heading */
  description?: ReactNode
  /** Optional recovery action rendered as a button */
  action?: EmptyStateAction
  /** Compact variant for inline/tab contexts (default: false) */
  compact?: boolean
}

/**
 * Standardized placeholder for empty, error, or missing-data states.
 * Two sizes: full (default) for page-level empties, compact for tab/section content.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps): ReactNode {
  if (compact) {
    return (
      <div className="empty-state-sm">
        <p>{title}</p>
        {description && <p>{description}</p>}
        {action && (
          <button className="btn btn-sm empty-state-action" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="empty-state">
      {icon && <span className="empty-icon">{icon}</span>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && (
        <button className="btn btn-sm empty-state-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
