import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { PendingOperationsProvider, usePendingOperations } from './PendingOperations'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.removeChild(container)
})

let opsApi: ReturnType<typeof usePendingOperations>

function TestHarness(): React.JSX.Element {
  opsApi = usePendingOperations()
  return (
    <div>
      <span data-testid="count">{opsApi.count}</span>
      <span data-testid="ops">{JSON.stringify([...opsApi.operations.values()])}</span>
    </div>
  )
}

function renderWithProvider(): void {
  act(() => {
    root.render(
      <PendingOperationsProvider>
        <TestHarness />
      </PendingOperationsProvider>
    )
  })
}

function getCount(): number {
  return Number(document.querySelector('[data-testid="count"]')!.textContent)
}

function getOps(): Array<{ id: string; label: string }> {
  return JSON.parse(document.querySelector('[data-testid="ops"]')!.textContent!)
}

describe('usePendingOperations — outside provider', () => {
  test('throws when used outside PendingOperationsProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => {
      act(() => {
        root.render(<TestHarness />)
      })
    }).toThrow('usePendingOperations must be used within a PendingOperationsProvider')
    spy.mockRestore()
  })
})

describe('PendingOperationsProvider — start/finish', () => {
  test('starts with zero operations', () => {
    renderWithProvider()
    expect(getCount()).toBe(0)
    expect(getOps()).toEqual([])
  })

  test('start adds an operation', () => {
    renderWithProvider()

    act(() => {
      opsApi.start('op-1', 'Saving config')
    })

    expect(getCount()).toBe(1)
    expect(getOps()).toEqual([{ id: 'op-1', label: 'Saving config' }])
  })

  test('start multiple operations', () => {
    renderWithProvider()

    act(() => {
      opsApi.start('op-1', 'Saving')
      opsApi.start('op-2', 'Building')
      opsApi.start('op-3', 'Deploying')
    })

    expect(getCount()).toBe(3)
  })

  test('finish removes an operation', () => {
    renderWithProvider()

    act(() => {
      opsApi.start('op-1', 'Saving')
      opsApi.start('op-2', 'Building')
    })
    expect(getCount()).toBe(2)

    act(() => {
      opsApi.finish('op-1')
    })
    expect(getCount()).toBe(1)
    expect(getOps()).toEqual([{ id: 'op-2', label: 'Building' }])
  })

  test('finish with unknown id is a no-op', () => {
    renderWithProvider()

    act(() => {
      opsApi.start('op-1', 'Saving')
    })

    act(() => {
      opsApi.finish('unknown')
    })
    expect(getCount()).toBe(1)
  })

  test('start with duplicate id overwrites the label', () => {
    renderWithProvider()

    act(() => {
      opsApi.start('op-1', 'First')
    })

    act(() => {
      opsApi.start('op-1', 'Updated')
    })

    expect(getCount()).toBe(1)
    expect(getOps()).toEqual([{ id: 'op-1', label: 'Updated' }])
  })

  test('finish all operations returns to zero', () => {
    renderWithProvider()

    act(() => {
      opsApi.start('op-1', 'A')
      opsApi.start('op-2', 'B')
    })

    act(() => {
      opsApi.finish('op-1')
      opsApi.finish('op-2')
    })

    expect(getCount()).toBe(0)
    expect(getOps()).toEqual([])
  })
})
