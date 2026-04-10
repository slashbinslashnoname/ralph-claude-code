import React, { createContext, useCallback, useContext, useRef, useState } from 'react'

/* ── Types ────────────────────────────────────────────────────────────────── */

export type ToastVariant = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  message: string
  variant: ToastVariant
}

export interface ToastOptions {
  variant?: ToastVariant
  /** Auto-dismiss delay in ms. Pass 0 to disable. Default 4000. */
  duration?: number
}

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => string
  dismissToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/* ── Hook ─────────────────────────────────────────────────────────────────── */

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}

/* ── Provider ─────────────────────────────────────────────────────────────── */

let nextId = 0

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (message: string, options?: ToastOptions): string => {
      const id = `toast-${++nextId}`
      const variant = options?.variant ?? 'info'
      const duration = options?.duration ?? 4000

      setToasts((prev) => [...prev, { id, message, variant }])

      if (duration > 0) {
        const timer = setTimeout(() => {
          timersRef.current.delete(id)
          setToasts((prev) => prev.filter((t) => t.id !== id))
        }, duration)
        timersRef.current.set(id, timer)
      }

      return id
    },
    []
  )

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

/* ── Container ────────────────────────────────────────────────────────────── */

const VARIANT_ICONS: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ'
}

function ToastContainer({
  toasts,
  onDismiss
}: {
  toasts: Toast[]
  onDismiss: (id: string) => void
}): React.JSX.Element | null {
  if (toasts.length === 0) return null

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.variant}`}
          role="alert"
          onClick={() => onDismiss(toast.id)}
        >
          <span className="toast-icon">{VARIANT_ICONS[toast.variant]}</span>
          <span className="toast-message">{toast.message}</span>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(toast.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
