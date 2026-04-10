import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { EmptyState } from './EmptyState'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  document.body.removeChild(container)
})

describe('EmptyState — full size rendering', () => {
  test('renders title and icon', async () => {
    await act(async () => {
      root.render(<EmptyState icon={'\u29BE'} title="No beads" />)
    })
    expect(container.querySelector('.empty-state')).not.toBeNull()
    expect(container.querySelector('.empty-icon')?.textContent).toBe('\u29BE')
    expect(container.querySelector('h3')?.textContent).toBe('No beads')
  })

  test('renders without icon', async () => {
    await act(async () => {
      root.render(<EmptyState title="Nothing here" />)
    })
    expect(container.querySelector('.empty-icon')).toBeNull()
    expect(container.querySelector('h3')?.textContent).toBe('Nothing here')
  })

  test('renders description', async () => {
    await act(async () => {
      root.render(<EmptyState title="No data" description="Try again later." />)
    })
    expect(container.querySelector('p')?.textContent).toBe('Try again later.')
  })

  test('renders action button', async () => {
    const onClick = vi.fn()
    await act(async () => {
      root.render(
        <EmptyState title="No items" action={{ label: 'Refresh', onClick }} />,
      )
    })
    const btn = container.querySelector('.empty-state-action') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toBe('Refresh')
    btn.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  test('does not render action when not provided', async () => {
    await act(async () => {
      root.render(<EmptyState title="Empty" />)
    })
    expect(container.querySelector('.empty-state-action')).toBeNull()
  })
})

describe('EmptyState — compact rendering', () => {
  test('renders compact variant with sm class', async () => {
    await act(async () => {
      root.render(<EmptyState title="No logs yet." compact />)
    })
    expect(container.querySelector('.empty-state-sm')).not.toBeNull()
    expect(container.querySelector('.empty-state')).toBeNull()
    expect(container.querySelector('p')?.textContent).toBe('No logs yet.')
  })

  test('compact variant does not render icon', async () => {
    await act(async () => {
      root.render(<EmptyState icon={'\u29BE'} title="Nothing" compact />)
    })
    expect(container.querySelector('.empty-icon')).toBeNull()
  })

  test('compact variant renders description', async () => {
    await act(async () => {
      root.render(<EmptyState title="Empty" description="Add items." compact />)
    })
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs.length).toBe(2)
    expect(paragraphs[1].textContent).toBe('Add items.')
  })

  test('compact variant renders action button', async () => {
    const onClick = vi.fn()
    await act(async () => {
      root.render(
        <EmptyState title="No data" action={{ label: 'Retry', onClick }} compact />,
      )
    })
    const btn = container.querySelector('.empty-state-action') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toBe('Retry')
    btn.click()
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('EmptyState — description as ReactNode', () => {
  test('accepts JSX as description', async () => {
    await act(async () => {
      root.render(
        <EmptyState
          title="CLI missing"
          description={<>Install with <code>cargo install beads-rust</code></>}
        />,
      )
    })
    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toBe('cargo install beads-rust')
  })
})
