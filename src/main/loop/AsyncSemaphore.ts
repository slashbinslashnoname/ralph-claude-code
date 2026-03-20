/**
 * Promise-based binary semaphore (mutex) for async coordination.
 * Replaces spin-wait locking with a FIFO queue of promise resolvers.
 */
export class AsyncSemaphore {
  private locked = false
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> }> = []

  /** Acquire the semaphore. Resolves when the lock is obtained, rejects on timeout. */
  acquire(timeoutMs = 5000): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const entry: { resolve: () => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject }

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const idx = this.queue.indexOf(entry)
          if (idx !== -1) {
            this.queue.splice(idx, 1)
          }
          reject(new Error(`AsyncSemaphore: acquire timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      this.queue.push(entry)
    })
  }

  /** Release the semaphore, passing it to the next waiter in FIFO order. */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      if (next.timer) clearTimeout(next.timer)
      // Keep locked = true, ownership transfers to next waiter
      next.resolve()
    } else {
      this.locked = false
    }
  }
}
