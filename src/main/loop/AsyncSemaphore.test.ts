import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
    assert.deepStrictEqual(order, [1])

    // Release first — second should get it
    sem.release()
    await second
    assert.deepStrictEqual(order, [1, 2])

    // Release second — third should get it
    sem.release()
    await third
    assert.deepStrictEqual(order, [1, 2, 3])

    sem.release()
  })

  it('acquire rejects on timeout', async () => {
    const sem = new AsyncSemaphore()
    await sem.acquire() // hold the lock

    await assert.rejects(
      () => sem.acquire(50), // 50ms timeout
      { message: /timed out after 50ms/ }
    )

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
    assert.strictEqual(await second, 'got-it')

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
    assert.strictEqual(await timedOut, 'timeout')

    // Release — second waiter should get the lock, not the timed-out one
    sem.release()
    assert.strictEqual(await second, 'got-it')
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

    assert.equal(acquired, true, 'should acquire on retry')
    assert.equal(attempts, 2, 'should succeed on second attempt')
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

    assert.equal(attempts, 3, 'should exhaust all retries')
    sem.release() // cleanup
  })

  it('concurrent acquire+release stress test', async () => {
    const sem = new AsyncSemaphore()
    let counter = 0

    const tasks = Array.from({ length: 10 }, async (_, i) => {
      await sem.acquire(2000)
      counter++
      // Simulate brief work
      await new Promise(r => setTimeout(r, 5))
      sem.release()
    })

    await Promise.all(tasks)
    assert.equal(counter, 10, 'all tasks should complete')
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
    assert.deepStrictEqual(order, ['w2-timeout'])

    // Release holder → w1 gets it (w2 was removed from queue)
    sem.release()
    await w1
    assert.deepStrictEqual(order, ['w2-timeout', 'w1'])

    // Release w1 → w3 gets it
    sem.release()
    await w3
    assert.deepStrictEqual(order, ['w2-timeout', 'w1', 'w3'])

    sem.release()
  })
})
