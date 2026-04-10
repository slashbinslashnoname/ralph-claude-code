import { useCallback, useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { useAsyncOp } from '../hooks/useAsyncOp'

export interface AsyncButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /** Async function to execute on click */
  onClick: () => Promise<unknown>
  /** Content to show while the operation is pending */
  pendingContent?: ReactNode
  /** Content to show on error (auto-clears after errorTimeout ms) */
  errorContent?: ReactNode
  /** Content to show on success (auto-clears after successTimeout ms) */
  successContent?: ReactNode
  /** ms before error state resets to idle (default 3000) */
  errorTimeout?: number
  /** ms before success state resets to idle (default 1500) */
  successTimeout?: number
  /** Extra CSS classes appended to .btn */
  className?: string
  children: ReactNode
}

/**
 * Button with built-in loading, disabled, error, and success states
 * driven by useAsyncOp. Prevents double-clicks while an operation is pending.
 */
export function AsyncButton({
  onClick,
  pendingContent,
  errorContent,
  successContent,
  errorTimeout = 3000,
  successTimeout = 1500,
  className = '',
  disabled,
  children,
  ...rest
}: AsyncButtonProps): ReactNode {
  const op = useAsyncOp(onClick)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  // Auto-reset after success or error
  useEffect(() => {
    if (op.status === 'success' || op.status === 'error') {
      const ms = op.status === 'success' ? successTimeout : errorTimeout
      timerRef.current = setTimeout(() => op.reset(), ms)
      return () => clearTimeout(timerRef.current)
    }
  }, [op.status, op.reset, successTimeout, errorTimeout])

  // Clean up timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const handleClick = useCallback(() => {
    op.run()
  }, [op.run])

  const isPending = op.status === 'pending'

  const content = (() => {
    switch (op.status) {
      case 'pending':
        return pendingContent ?? children
      case 'error':
        return errorContent ?? children
      case 'success':
        return successContent ?? children
      default:
        return children
    }
  })()

  return (
    <button
      {...rest}
      className={`btn ${className} ${op.status !== 'idle' ? `async-btn-${op.status}` : ''}`.trim()}
      disabled={disabled || isPending}
      onClick={handleClick}
      aria-busy={isPending}
    >
      {isPending && <span className="async-btn-spinner" aria-hidden="true" />}
      {content}
    </button>
  )
}
