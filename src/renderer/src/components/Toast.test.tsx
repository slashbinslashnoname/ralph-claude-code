import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ToastProvider, useToast } from './Toast'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  vi.useRealTimers()
  document.body.removeChild(container)
})

/* Helper component that exposes toast controls via refs */
let toastApi: ReturnType<typeof useToast>

function TestHarness(): React.JSX.Element {
  toastApi = useToast()
  return <div data-testid="harness" />
}

function renderWithProvider(): void {
  act(() => {
    root.render(
      <ToastProvider>
        <TestHarness />
      </ToastProvider>
    )
  })
}

function getToasts(): NodeListOf<Element> {
  return document.querySelectorAll('.toast')
}

describe('useToast — outside provider', () => {
  test('throws when used outside ToastProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => {
      act(() => {
        root.render(<TestHarness />)
      })
    }).toThrow('useToast must be used within a ToastProvider')
    spy.mockRestore()
  })
})

describe('ToastProvider — showToast', () => {
  test('renders a toast with the given message', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('File saved')
    })

    const toasts = getToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].textContent).toContain('File saved')
  })

  test('renders multiple toasts', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('First')
      toastApi.showToast('Second')
      toastApi.showToast('Third')
    })

    expect(getToasts()).toHaveLength(3)
  })

  test('returns a unique id for each toast', () => {
    renderWithProvider()

    let id1: string, id2: string
    act(() => {
      id1 = toastApi.showToast('A')
      id2 = toastApi.showToast('B')
    })

    expect(id1!).toBeTruthy()
    expect(id2!).toBeTruthy()
    expect(id1!).not.toBe(id2!)
  })
})

describe('ToastProvider — variants', () => {
  test('defaults to info variant', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Info message')
    })

    expect(getToasts()[0].className).toContain('toast-info')
  })

  test('applies success variant', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Done!', { variant: 'success' })
    })

    expect(getToasts()[0].className).toContain('toast-success')
  })

  test('applies error variant', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Failed', { variant: 'error' })
    })

    expect(getToasts()[0].className).toContain('toast-error')
  })
})

describe('ToastProvider — auto-dismiss', () => {
  test('auto-dismisses after default 4000ms', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Temporary')
    })
    expect(getToasts()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(getToasts()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(getToasts()).toHaveLength(0)
  })

  test('auto-dismisses after custom duration', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Quick', { duration: 1000 })
    })

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(getToasts()).toHaveLength(0)
  })

  test('does not auto-dismiss when duration is 0', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Persistent', { duration: 0 })
    })

    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(getToasts()).toHaveLength(1)
  })
})

describe('ToastProvider — dismissToast', () => {
  test('dismisses a toast by id', () => {
    renderWithProvider()

    let id: string
    act(() => {
      id = toastApi.showToast('Dismiss me', { duration: 0 })
    })
    expect(getToasts()).toHaveLength(1)

    act(() => {
      toastApi.dismissToast(id!)
    })
    expect(getToasts()).toHaveLength(0)
  })

  test('clicking the close button dismisses the toast', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Click to close', { duration: 0 })
    })

    const closeBtn = document.querySelector('.toast-close') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()

    act(() => {
      closeBtn.click()
    })
    expect(getToasts()).toHaveLength(0)
  })

  test('clicking the toast body dismisses it', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Click body', { duration: 0 })
    })

    act(() => {
      (getToasts()[0] as HTMLElement).click()
    })
    expect(getToasts()).toHaveLength(0)
  })

  test('dismissing clears the auto-dismiss timer', () => {
    renderWithProvider()

    let id: string
    act(() => {
      id = toastApi.showToast('Will dismiss early', { duration: 5000 })
    })

    act(() => {
      toastApi.dismissToast(id!)
    })
    expect(getToasts()).toHaveLength(0)

    // Advancing past original timeout should not cause errors
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(getToasts()).toHaveLength(0)
  })
})

describe('ToastContainer — accessibility', () => {
  test('toast container has aria-live polite', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Accessible')
    })

    const containerEl = document.querySelector('.toast-container')
    expect(containerEl?.getAttribute('aria-live')).toBe('polite')
  })

  test('individual toasts have role=alert', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('Alert toast')
    })

    expect(getToasts()[0].getAttribute('role')).toBe('alert')
  })

  test('close button has aria-label', () => {
    renderWithProvider()

    act(() => {
      toastApi.showToast('With close')
    })

    const closeBtn = document.querySelector('.toast-close')
    expect(closeBtn?.getAttribute('aria-label')).toBe('Dismiss')
  })
})

describe('ToastContainer — empty state', () => {
  test('does not render container when there are no toasts', () => {
    renderWithProvider()

    expect(document.querySelector('.toast-container')).toBeNull()
  })
})
