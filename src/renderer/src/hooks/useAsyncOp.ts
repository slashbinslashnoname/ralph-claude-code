import { useState, useCallback, useRef } from 'react'

export type AsyncOpStatus = 'idle' | 'pending' | 'success' | 'error'

export interface AsyncOpState<T> {
  run: (...args: unknown[]) => Promise<T | undefined>
  status: AsyncOpStatus
  error: string | null
  data: T | undefined
  reset: () => void
}

/**
 * Hook for managing async operations with status tracking.
 * Wraps an async function and tracks idle → pending → success/error transitions.
 * Stale responses from superseded calls are ignored.
 */
export function useAsyncOp<T>(
  asyncFn: (...args: unknown[]) => Promise<T>,
): AsyncOpState<T> {
  const [status, setStatus] = useState<AsyncOpStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<T | undefined>(undefined)
  const callIdRef = useRef(0)

  const run = useCallback(
    async (...args: unknown[]): Promise<T | undefined> => {
      const id = ++callIdRef.current
      setStatus('pending')
      setError(null)
      try {
        const result = await asyncFn(...args)
        if (id === callIdRef.current) {
          setData(result)
          setStatus('success')
        }
        return result
      } catch (e) {
        if (id === callIdRef.current) {
          const msg = e instanceof Error ? e.message : String(e)
          setError(msg)
          setStatus('error')
        }
        return undefined
      }
    },
    [asyncFn],
  )

  const reset = useCallback(() => {
    callIdRef.current++
    setStatus('idle')
    setError(null)
    setData(undefined)
  }, [])

  return { run, status, error, data, reset }
}
