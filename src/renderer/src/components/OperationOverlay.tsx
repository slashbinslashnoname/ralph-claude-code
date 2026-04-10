import type { ReactNode } from 'react'

export interface OperationOverlayProps {
  /** Whether the overlay is visible */
  active: boolean
  /** Message to show on the overlay */
  message?: string
  /** Child content that gets blocked by the overlay */
  children: ReactNode
}

/**
 * Full-component blocking overlay for rare scenarios where the entire
 * component must be disabled during an operation (e.g. destructive actions,
 * multi-step wizards). Prevents all interaction with child content.
 */
export function OperationOverlay({
  active,
  message = 'Operation in progress…',
  children,
}: OperationOverlayProps): ReactNode {
  return (
    <div className="operation-overlay-container">
      {children}
      {active && (
        <div className="operation-overlay" role="alert" aria-busy="true">
          <div className="operation-overlay-content">
            <span className="operation-overlay-spinner" aria-hidden="true" />
            <span className="operation-overlay-message">{message}</span>
          </div>
        </div>
      )}
    </div>
  )
}
