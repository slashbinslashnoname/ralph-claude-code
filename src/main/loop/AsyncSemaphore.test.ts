import { describe, it, expect } from 'vitest'
import { AsyncSemaphore } from './AsyncSemaphore'

describe('AsyncSemaphore', () => {
  it('single acquire and release works', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire()
    sem.release()
    // Should be able to acquire again after release
    await sem.acquire()
    sem.release()
  })

  it('second acquire blocks until first releases (FIFO)', async () => {
    const sem = new AsyncSemaphore()
    const order: number[] = []

    await sem.acquire()
    order.push(1) // first holder

    const second = sem.acquire().then(() => {
      order.push(2)
    })

    const third = sem.acquire().then(() => {
      order.push(3)
    })

    // Neither second nor third should have resolved yet
    await Promise.resolve() // flush microtasks
    expect(order).toEqual([1])

    // Release first — second should get it
    sem.release()
    await second
    expect(order).toEqual([1, 2])

    // Release second — third should get it
    sem.release()
    await third
    expect(order).toEqual([1, 2, 3])

    sem.release()
  })

  it('acquire rejects on timeout', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire() // hold the lock

    await expect(
      sem.acquire(50) // 50ms timeout
    ).rejects.toThrow(/timed out after 50ms/)

    // Semaphore should still be usable after timeout
    sem.release()
    await sem.acquire()
    sem.release()
  })

  it('release without acquire is a no-op', () => {
    const sem = new AsyncSemaphore()
    // Release without acquire should not crash
    sem.release()
    sem.release()
  })

  it('double release does not corrupt state', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire()

    // Queue a waiter
    const second = sem.acquire(5000).then(() => 'got-it')

    // First release hands lock to second waiter
    sem.release()
    expect(await second).toBe('got-it')

    // Second release (accidental) while second waiter holds the lock
    // should NOT unlock the semaphore — second waiter still holds it
    sem.release() // legitimate release by second waiter

    // Extra release — should be no-op since lock is now free
    sem.release()

    // Semaphore should still work correctly
    await sem.acquire()
    sem.release()
  })

  it('multiple sequential acquire/release cycles', async () => {
    const sem = new AsyncSemaphore()
    for (let i = 0; i < 10; i++) {
      await sem.acquire()
      sem.release()
    }
  })

  it('timed-out waiter does not leak into queue', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire() // hold lock

    // Start a waiter that will time out
    const timedOut = sem.acquire(30).catch(() => 'timeout')

    // Start a second waiter that should succeed after release
    const second = sem.acquire(5000).then(() => 'got-it')

    await timedOut
    expect(await timedOut).toBe('timeout')

    // Release — second waiter should get the lock, not the timed-out one
    sem.release()
    expect(await second).toBe('got-it')
    sem.release()
  })

  it('acquire with retry pattern — retry succeeds after timeout', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire() // hold the lock

    // Simulate retry-on-timeout: first attempt times out, second succeeds
    let acquired = false
    const maxRetries = 3
    let attempts = 0

    // Release after 80ms — first 30ms attempt fails, second succeeds
    setTimeout(() => sem.release(), 80)

    for (let i = 0; i < maxRetries; i++) {
      attempts++
      try {
        await sem.acquire(50) // 50ms timeout
        acquired = true
        break
      } catch {
        // timeout — retry
      }
    }

    expect(acquired).toBe(true)
    expect(attempts).toBe(2)
    sem.release()
  })

  it('acquire with retry pattern — respects max retries', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire() // hold the lock, never release

    const maxRetries = 3
    let attempts = 0

    for (let i = 0; i < maxRetries; i++) {
      attempts++
      try {
        await sem.acquire(20)
        break
      } catch {
        // timeout — retry
      }
    }

    expect(attempts).toBe(3)
    sem.release() // cleanup
  })

  it('concurrent acquire+release stress test', async () => {
    const sem = new AsyncSemaphore()
    let counter = 0

    const tasks = Array.from({ length: 10 }, async () => {
      await sem.acquire(2000)
      counter++
      // Simulate brief work
      await new Promise(r => setTimeout(r, 5))
      sem.release()
    })

    await Promise.all(tasks)
    expect(counter).toBe(10)
  })

  it('middle waiter times out, FIFO preserved for survivors', async () => {
    const sem = new AsyncSemaphore()
    const order: string[] = []

    await sem.acquire() // holder

    const w1 = sem.acquire(5000).then(() => { order.push('w1') })
    const w2 = sem.acquire(30).catch(() => { order.push('w2-timeout') })
    const w3 = sem.acquire(5000).then(() => { order.push('w3') })

    // Wait for w2 to time out
    await w2
    expect(order).toEqual(['w2-timeout'])

    // Release holder → w1 gets it (w2 was removed from queue)
    sem.release()
    await w1
    expect(order).toEqual(['w2-timeout', 'w1'])

    // Release w1 → w3 gets it
    sem.release()
    await w3
    expect(order).toEqual(['w2-timeout', 'w1', 'w3'])

    sem.release()
  })
})
