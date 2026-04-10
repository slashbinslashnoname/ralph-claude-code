import { useEffect } from 'react'

type Unsubscribe = () => void

/**
 * Hook for subscribing to IPC events with automatic cleanup on unmount.
 * The `subscribe` function should call the IPC listener and return an unsubscribe function.
 * Re-subscribes whenever `deps` change.
 */
export function useIpcSubscription(
  subscribe: () => Unsubscribe | Unsubscribe[],
  deps: React.DependencyList = [],
): void {
  useEffect(() => {
    const result = subscribe()
    if (Array.isArray(result)) {
      return () => result.forEach((unsub) => unsub())
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
