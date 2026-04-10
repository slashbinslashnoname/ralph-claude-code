import { describe, test, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { useAsyncOp, type AsyncOpState } from './useAsyncOp'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, 'useAsyncOp.ts'), 'utf-8')

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

/** Renders hook into a component and returns a mutable ref to hook state */
function renderHook<T>(asyncFn: (...args: unknown[]) => Promise<T>) {
  const ref: { current: AsyncOpState<T> | null } = { current: null }

  function TestComponent() {
    const state = useAsyncOp(asyncFn)
    ref.current = state
    return (
      <div data-status={state.status} data-error={state.error ?? ''}>
        {state.data !== undefined ? JSON.stringify(state.data) : ''}
      </div>
    )
  }

  return { ref, TestComponent }
}

describe('useAsyncOp — initial state', () => {
  test('starts with idle status, null error, undefined data', async () => {
    const fn = vi.fn()
    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    expect(ref.current!.status).toBe('idle')
    expect(ref.current!.error).toBeNull()
    expect(ref.current!.data).toBeUndefined()
    expect(typeof ref.current!.run).toBe('function')
    expect(typeof ref.current!.reset).toBe('function')
  })
})

describe('useAsyncOp — successful operation', () => {
  test('transitions idle → pending → success with data', async () => {
    const statuses: string[] = []
    const fn = vi.fn().mockResolvedValue({ ok: true, items: [1, 2] })

    function Observer() {
      const state = useAsyncOp(fn)
      statuses.push(state.status)
      return (
        <button onClick={() => state.run('arg1')}>
          {state.status}:{state.data ? JSON.stringify(state.data) : 'none'}
        </button>
      )
    }

    await act(async () => {
      createRoot(container).render(<Observer />)
    })

    expect(statuses).toContain('idle')

    const btn = container.querySelector('button')!
    await act(async () => {
      btn.click()
    })

    expect(fn).toHaveBeenCalledWith('arg1')
    expect(statuses).toContain('success')
    expect(container.innerHTML).toContain('"ok":true')
  })

  test('run returns the resolved value', async () => {
    const fn = vi.fn().mockResolvedValue(42)
    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    let result: unknown
    await act(async () => {
      result = await ref.current!.run()
    })

    expect(result).toBe(42)
  })
})

describe('useAsyncOp — failed operation', () => {
  test('transitions to error status with error message from Error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Network failure'))
    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    await act(async () => {
      await ref.current!.run()
    })

    expect(ref.current!.status).toBe('error')
    expect(ref.current!.error).toBe('Network failure')
    expect(ref.current!.data).toBeUndefined()
  })

  test('handles non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error')
    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    await act(async () => {
      await ref.current!.run()
    })

    expect(ref.current!.status).toBe('error')
    expect(ref.current!.error).toBe('string error')
  })

  test('run returns undefined on error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    let result: unknown
    await act(async () => {
      result = await ref.current!.run()
    })

    expect(result).toBeUndefined()
  })
})

describe('useAsyncOp — reset', () => {
  test('reset returns to idle state', async () => {
    const fn = vi.fn().mockResolvedValue('data')
    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    await act(async () => {
      await ref.current!.run()
    })
    expect(ref.current!.status).toBe('success')

    await act(async () => {
      ref.current!.reset()
    })

    expect(ref.current!.status).toBe('idle')
    expect(ref.current!.error).toBeNull()
    expect(ref.current!.data).toBeUndefined()
  })
})

describe('useAsyncOp — pending guard', () => {
  test('calling run while pending starts a new call (old result becomes stale)', async () => {
    let resolveFirst: (v: string) => void
    let resolveSecond: (v: string) => void
    const first = new Promise<string>((r) => { resolveFirst = r })
    const second = new Promise<string>((r) => { resolveSecond = r })

    let callCount = 0
    const fn = vi.fn(() => {
      callCount++
      return callCount === 1 ? first : second
    })

    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    // First call — enters pending
    await act(async () => {
      ref.current!.run()
    })
    expect(ref.current!.status).toBe('pending')

    // Second call while still pending — fn is called again
    await act(async () => {
      ref.current!.run()
    })
    expect(fn).toHaveBeenCalledTimes(2)
    expect(ref.current!.status).toBe('pending')

    // Resolve second call
    await act(async () => {
      resolveSecond!('latest')
    })
    expect(ref.current!.status).toBe('success')
    expect(ref.current!.data).toBe('latest')

    // Resolve first (stale) — should not overwrite
    await act(async () => {
      resolveFirst!('stale')
    })
    expect(ref.current!.data).toBe('latest')
  })
})

describe('useAsyncOp — stale response handling', () => {
  test('ignores result from superseded call', async () => {
    let resolveFirst: (v: string) => void
    let resolveSecond: (v: string) => void
    const first = new Promise<string>((r) => { resolveFirst = r })
    const second = new Promise<string>((r) => { resolveSecond = r })

    let callCount = 0
    const fn = vi.fn(() => {
      callCount++
      return callCount === 1 ? first : second
    })

    const { ref, TestComponent } = renderHook(fn)

    await act(async () => {
      createRoot(container).render(<TestComponent />)
    })

    // Start first call
    let p1: Promise<unknown>
    await act(async () => {
      p1 = ref.current!.run()
    })

    // Start second call (supersedes first)
    let p2: Promise<unknown>
    await act(async () => {
      p2 = ref.current!.run()
    })

    // Resolve second first
    await act(async () => {
      resolveSecond!('second')
      await p2!
    })

    expect(ref.current!.data).toBe('second')
    expect(ref.current!.status).toBe('success')

    // Resolve first (stale — should be ignored)
    await act(async () => {
      resolveFirst!('first')
      await p1!
    })

    // Data should still be 'second', not overwritten by stale 'first'
    expect(ref.current!.data).toBe('second')
    expect(ref.current!.status).toBe('success')
  })
})

describe('useAsyncOp — source analysis', () => {
  test('exports AsyncOpStatus type', () => {
    expect(src).toContain("export type AsyncOpStatus = 'idle' | 'pending' | 'success' | 'error'")
  })

  test('exports AsyncOpState interface', () => {
    expect(src).toContain('export interface AsyncOpState<T>')
  })

  test('exports useAsyncOp as named export', () => {
    expect(src).toContain('export function useAsyncOp')
  })

  test('uses useCallback for run and reset', () => {
    expect(src).toContain('useCallback')
  })

  test('uses useRef for stale call tracking', () => {
    expect(src).toContain('useRef')
    expect(src).toContain('callIdRef')
  })
})
