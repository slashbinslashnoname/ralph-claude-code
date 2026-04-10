import { describe, test, expect, vi, beforeEach } from 'vitest'
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { useIpcSubscription } from './useIpcSubscription'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, 'useIpcSubscription.ts'), 'utf-8')

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

describe('useIpcSubscription — single unsubscribe', () => {
  test('calls subscribe on mount and unsubscribe on unmount', async () => {
    const unsub = vi.fn()
    const subscribe = vi.fn(() => unsub)

    function TestComponent() {
      useIpcSubscription(subscribe, [])
      return <div>mounted</div>
    }

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root.render(<TestComponent />)
    })

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(unsub).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })

    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

describe('useIpcSubscription — array of unsubscribes', () => {
  test('calls all unsubscribes on unmount', async () => {
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()
    const unsub3 = vi.fn()
    const subscribe = vi.fn(() => [unsub1, unsub2, unsub3])

    function TestComponent() {
      useIpcSubscription(subscribe, [])
      return <div>mounted</div>
    }

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root.render(<TestComponent />)
    })

    expect(subscribe).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.unmount()
    })

    expect(unsub1).toHaveBeenCalledTimes(1)
    expect(unsub2).toHaveBeenCalledTimes(1)
    expect(unsub3).toHaveBeenCalledTimes(1)
  })
})

describe('useIpcSubscription — dependency changes', () => {
  test('re-subscribes when deps change', async () => {
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()
    let callCount = 0
    const subscribe = vi.fn(() => {
      callCount++
      return callCount === 1 ? unsub1 : unsub2
    })

    function TestComponent({ dep }: { dep: string }) {
      useIpcSubscription(() => subscribe(dep), [dep])
      return <div>{dep}</div>
    }

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root.render(<TestComponent dep="a" />)
    })

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith('a')

    // Change dep → re-subscribes
    await act(async () => {
      root.render(<TestComponent dep="b" />)
    })

    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(subscribe).toHaveBeenCalledWith('b')
    // Old subscription cleaned up
    expect(unsub1).toHaveBeenCalledTimes(1)
  })
})

describe('useIpcSubscription — real IPC-like pattern', () => {
  test('works with typical window.slashbot listener pattern', async () => {
    let capturedCallback: ((data: string) => void) | null = null
    const unsub = vi.fn()
    const mockListener = vi.fn((cb: (data: string) => void) => {
      capturedCallback = cb
      return unsub
    })

    function TestComponent() {
      const [value, setValue] = useState('')
      useIpcSubscription(() => mockListener(setValue), [])
      return <div data-testid="value">{value}</div>
    }

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    expect(mockListener).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')

    // Simulate IPC event
    await act(async () => {
      capturedCallback!('hello from IPC')
    })

    expect(container.textContent).toBe('hello from IPC')
  })

  test('works with multiple IPC listeners pattern', async () => {
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()
    const listener1 = vi.fn(() => unsub1)
    const listener2 = vi.fn(() => unsub2)

    function TestComponent() {
      useIpcSubscription(() => [listener1(), listener2()], [])
      return <div>multi</div>
    }

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root.render(<TestComponent />)
    })

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.unmount()
    })

    expect(unsub1).toHaveBeenCalledTimes(1)
    expect(unsub2).toHaveBeenCalledTimes(1)
  })
})

describe('useIpcSubscription — no stale closure', () => {
  test('re-subscription after dep change uses fresh callback, not stale closure', async () => {
    const values: string[] = []
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()

    function TestComponent({ filter }: { filter: string }) {
      useIpcSubscription(() => {
        // Capture the current filter value to verify no stale closure
        values.push(filter)
        return values.length === 1 ? unsub1 : unsub2
      }, [filter])
      return <div>{filter}</div>
    }

    let root: ReturnType<typeof createRoot>
    await act(async () => {
      root = createRoot(container)
      root.render(<TestComponent filter="alpha" />)
    })

    expect(values).toEqual(['alpha'])

    // Change dep — should re-subscribe with new value, not stale "alpha"
    await act(async () => {
      root.render(<TestComponent filter="beta" />)
    })

    expect(values).toEqual(['alpha', 'beta'])
    // Old subscription was cleaned up
    expect(unsub1).toHaveBeenCalledTimes(1)
  })
})

describe('useIpcSubscription — source analysis', () => {
  test('exports useIpcSubscription as named export', () => {
    expect(src).toContain('export function useIpcSubscription')
  })

  test('uses useEffect internally', () => {
    expect(src).toContain('useEffect')
  })

  test('handles both single and array return types', () => {
    expect(src).toContain('Array.isArray')
  })

  test('accepts a deps parameter', () => {
    expect(src).toContain('deps')
  })
})
