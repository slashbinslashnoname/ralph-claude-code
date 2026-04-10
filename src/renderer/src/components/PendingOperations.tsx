import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

/* ── Types ────────────────────────────────────────────────────────────────── */

export interface PendingOperation {
  id: string
  label: string
}

interface PendingOperationsContextValue {
  /** Current in-flight operations */
  operations: ReadonlyMap<string, PendingOperation>
  /** Register an in-flight operation. Returns its id for later removal. */
  start: (id: string, label: string) => void
  /** Mark an operation as finished. */
  finish: (id: string) => void
  /** Number of in-flight operations */
  count: number
}

const PendingOperationsContext = createContext<PendingOperationsContextValue | null>(null)

/* ── Hook ─────────────────────────────────────────────────────────────────── */

export function usePendingOperations(): PendingOperationsContextValue {
  const ctx = useContext(PendingOperationsContext)
  if (!ctx) throw new Error('usePendingOperations must be used within a PendingOperationsProvider')
  return ctx
}

/* ── Provider ─────────────────────────────────────────────────────────────── */

export function PendingOperationsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [ops, setOps] = useState<Map<string, PendingOperation>>(new Map())

  const start = useCallback((id: string, label: string) => {
    setOps(prev => {
      const next = new Map(prev)
      next.set(id, { id, label })
      return next
    })
  }, [])

  const finish = useCallback((id: string) => {
    setOps(prev => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const value = useMemo<PendingOperationsContextValue>(
    () => ({ operations: ops, start, finish, count: ops.size }),
    [ops, start, finish]
  )

  return (
    <PendingOperationsContext.Provider value={value}>
      {children}
    </PendingOperationsContext.Provider>
  )
}
