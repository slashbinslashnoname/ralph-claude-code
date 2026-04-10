import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { AsyncButton } from './AsyncButton'

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
  vi.useRealTimers()
  document.body.removeChild(container)
})

function getButton(): HTMLButtonElement {
  return container.querySelector('button')!
}

describe('AsyncButton — rendering', () => {
  test('renders children as button content', async () => {
    await act(async () => {
      root.render(
        <AsyncButton onClick={async () => {}}>Save</AsyncButton>,
      )
    })
    expect(getButton().textContent).toBe('Save')
  })

  test('applies className to button', async () => {
    await act(async () => {
      root.render(
        <AsyncButton onClick={async () => {}} className="btn-primary btn-sm">
          Go
        </AsyncButton>,
      )
    })
    expect(getButton().className).toContain('btn')
    expect(getButton().className).toContain('btn-primary')
    expect(getButton().className).toContain('btn-sm')
  })

  test('passes through extra button attributes', async () => {
    await act(async () => {
      root.render(
        <AsyncButton onClick={async () => {}} data-testid="save-btn" type="submit">
          Save
        </AsyncButton>,
      )
    })
    expect(getButton().getAttribute('data-testid')).toBe('save-btn')
    expect(getButton().type).toBe('submit')
  })
})

describe('AsyncButton — pending state', () => {
  test('disables button and shows spinner while pending', async () => {
    let resolve: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    const onClick = vi.fn(() => promise)

    await act(async () => {
      root.render(<AsyncButton onClick={onClick}>Save</AsyncButton>)
    })

    // Click to start operation
    await act(async () => {
      getButton().click()
    })

    expect(getButton().disabled).toBe(true)
    expect(getButton().getAttribute('aria-busy')).toBe('true')
    expect(getButton().className).toContain('async-btn-pending')
    expect(container.querySelector('.async-btn-spinner')).not.toBeNull()

    // Resolve to clean up
    await act(async () => {
      resolve!()
    })
  })

  test('shows pendingContent when provided', async () => {
    let resolve: () => void
    const promise = new Promise<void>((r) => { resolve = r })

    await act(async () => {
      root.render(
        <AsyncButton onClick={() => promise} pendingContent="Saving…">
          Save
        </AsyncButton>,
      )
    })

    await act(async () => {
      getButton().click()
    })

    expect(getButton().textContent).toContain('Saving…')

    await act(async () => {
      resolve!()
    })
  })

  test('prevents double-click while pending', async () => {
    let resolve: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    const onClick = vi.fn(() => promise)

    await act(async () => {
      root.render(<AsyncButton onClick={onClick}>Save</AsyncButton>)
    })

    await act(async () => {
      getButton().click()
    })

    // Button is disabled, so clicking again won't fire onClick
    expect(getButton().disabled).toBe(true)

    await act(async () => {
      resolve!()
    })
  })
})

describe('AsyncButton — success state', () => {
  test('shows success state and auto-resets', async () => {
    const onClick = vi.fn().mockResolvedValue('done')

    await act(async () => {
      root.render(
        <AsyncButton onClick={onClick} successContent="Saved!" successTimeout={1000}>
          Save
        </AsyncButton>,
      )
    })

    await act(async () => {
      getButton().click()
    })

    expect(getButton().textContent).toContain('Saved!')
    expect(getButton().className).toContain('async-btn-success')

    // After timeout, resets to idle
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(getButton().textContent).toBe('Save')
    expect(getButton().className).not.toContain('async-btn-success')
  })
})

describe('AsyncButton — error state', () => {
  test('shows error state and auto-resets', async () => {
    const onClick = vi.fn().mockRejectedValue(new Error('Network error'))

    await act(async () => {
      root.render(
        <AsyncButton onClick={onClick} errorContent="Failed!" errorTimeout={2000}>
          Save
        </AsyncButton>,
      )
    })

    await act(async () => {
      getButton().click()
    })

    expect(getButton().textContent).toContain('Failed!')
    expect(getButton().className).toContain('async-btn-error')
    expect(getButton().disabled).toBe(false) // Not pending, can retry

    // After timeout, resets to idle
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(getButton().textContent).toBe('Save')
    expect(getButton().className).not.toContain('async-btn-error')
  })
})

describe('AsyncButton — re-enabled after resolution', () => {
  test('button is re-enabled after successful resolution', async () => {
    const onClick = vi.fn().mockResolvedValue('done')

    await act(async () => {
      root.render(<AsyncButton onClick={onClick}>Save</AsyncButton>)
    })

    expect(getButton().disabled).toBe(false)

    await act(async () => {
      getButton().click()
    })

    // After success, button should not be disabled
    expect(getButton().disabled).toBe(false)
    expect(getButton().className).toContain('async-btn-success')
  })

  test('button is re-enabled after error resolution', async () => {
    const onClick = vi.fn().mockRejectedValue(new Error('fail'))

    await act(async () => {
      root.render(<AsyncButton onClick={onClick}>Save</AsyncButton>)
    })

    await act(async () => {
      getButton().click()
    })

    // After error, button should not be disabled (can retry)
    expect(getButton().disabled).toBe(false)
    expect(getButton().className).toContain('async-btn-error')
  })

  test('button returns to fully idle state after auto-reset timeout', async () => {
    const onClick = vi.fn().mockResolvedValue('done')

    await act(async () => {
      root.render(
        <AsyncButton onClick={onClick} successTimeout={1000}>
          Save
        </AsyncButton>,
      )
    })

    await act(async () => {
      getButton().click()
    })

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(getButton().disabled).toBe(false)
    expect(getButton().className).not.toContain('async-btn-success')
    expect(getButton().className).not.toContain('async-btn-pending')
    expect(getButton().className).not.toContain('async-btn-error')
    expect(getButton().textContent).toBe('Save')
  })
})

describe('AsyncButton — disabled prop', () => {
  test('respects external disabled prop', async () => {
    await act(async () => {
      root.render(
        <AsyncButton onClick={async () => {}} disabled>
          Save
        </AsyncButton>,
      )
    })

    expect(getButton().disabled).toBe(true)
  })
})
