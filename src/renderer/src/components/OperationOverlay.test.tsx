import { describe, test, expect, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { OperationOverlay } from './OperationOverlay'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

describe('OperationOverlay — inactive', () => {
  test('renders children without overlay when inactive', async () => {
    await act(async () => {
      root.render(
        <OperationOverlay active={false}>
          <p>Content</p>
        </OperationOverlay>,
      )
    })

    expect(container.querySelector('p')!.textContent).toBe('Content')
    expect(container.querySelector('.operation-overlay')).toBeNull()
  })
})

describe('OperationOverlay — active', () => {
  test('shows overlay with default message when active', async () => {
    await act(async () => {
      root.render(
        <OperationOverlay active={true}>
          <p>Content</p>
        </OperationOverlay>,
      )
    })

    const overlay = container.querySelector('.operation-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay!.getAttribute('role')).toBe('alert')
    expect(overlay!.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('.operation-overlay-message')!.textContent).toBe(
      'Operation in progress…',
    )
    expect(container.querySelector('.operation-overlay-spinner')).not.toBeNull()
  })

  test('shows custom message', async () => {
    await act(async () => {
      root.render(
        <OperationOverlay active={true} message="Deleting project…">
          <p>Content</p>
        </OperationOverlay>,
      )
    })

    expect(container.querySelector('.operation-overlay-message')!.textContent).toBe(
      'Deleting project…',
    )
  })

  test('children remain in DOM underneath overlay', async () => {
    await act(async () => {
      root.render(
        <OperationOverlay active={true}>
          <p data-testid="child">Still here</p>
        </OperationOverlay>,
      )
    })

    expect(container.querySelector('[data-testid="child"]')!.textContent).toBe('Still here')
    expect(container.querySelector('.operation-overlay')).not.toBeNull()
  })
})

describe('OperationOverlay — container structure', () => {
  test('wraps content in a relative container', async () => {
    await act(async () => {
      root.render(
        <OperationOverlay active={true}>
          <div>Inner</div>
        </OperationOverlay>,
      )
    })

    const wrapper = container.querySelector('.operation-overlay-container')
    expect(wrapper).not.toBeNull()
    expect(wrapper!.querySelector('.operation-overlay')).not.toBeNull()
  })
})
