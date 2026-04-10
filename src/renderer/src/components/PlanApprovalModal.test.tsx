import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import PlanApprovalModal from './PlanApprovalModal'
import type { PendingPlan } from './PlanApprovalModal'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.removeChild(container)
})

const makePlan = (overrides?: Partial<PendingPlan>): PendingPlan => ({
  planMd: '# Plan\n- Step 1\n- Step 2',
  request: 'Build a widget',
  projectPath: '/tmp/project',
  ...overrides,
})

describe('PlanApprovalModal — hidden when no plan', () => {
  test('renders nothing when pendingPlan is null', async () => {
    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={null} onApprove={vi.fn()} onReject={vi.fn()} />,
      )
    })
    expect(container.querySelector('.plan-modal-backdrop')).toBeNull()
    expect(container.querySelector('.plan-modal')).toBeNull()
  })
})

describe('PlanApprovalModal — visible with pending plan', () => {
  test('renders modal with plan content', async () => {
    const plan = makePlan()
    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={plan} onApprove={vi.fn()} onReject={vi.fn()} />,
      )
    })

    expect(container.querySelector('.plan-modal-backdrop')).not.toBeNull()
    const modal = container.querySelector('.plan-modal')
    expect(modal).not.toBeNull()
    expect(modal!.getAttribute('role')).toBe('dialog')
    expect(container.querySelector('.plan-modal-header h3')!.textContent).toBe('Plan awaiting approval')
    expect(container.querySelector('.plan-review-request')!.textContent).toBe('Build a widget')
    expect((container.querySelector('.plan-review-editor') as HTMLTextAreaElement).value).toBe(plan.planMd)
  })

  test('approve button calls onApprove with projectPath', async () => {
    const onApprove = vi.fn()
    const plan = makePlan()
    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={plan} onApprove={onApprove} onReject={vi.fn()} />,
      )
    })

    const approveBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    expect(approveBtn.textContent).toBe('Approve Plan')
    await act(async () => { approveBtn.click() })
    expect(onApprove).toHaveBeenCalledWith('/tmp/project', undefined)
  })

  test('reject button calls onReject with projectPath', async () => {
    const onReject = vi.fn()
    const plan = makePlan()
    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={plan} onApprove={vi.fn()} onReject={onReject} />,
      )
    })

    const rejectBtn = container.querySelector('.btn-danger') as HTMLButtonElement
    expect(rejectBtn.textContent).toBe('Reject')
    await act(async () => { rejectBtn.click() })
    expect(onReject).toHaveBeenCalledWith('/tmp/project')
  })

  test('editing plan passes modified text to onApprove', async () => {
    const onApprove = vi.fn()
    const plan = makePlan()
    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={plan} onApprove={onApprove} onReject={vi.fn()} />,
      )
    })

    const editor = container.querySelector('.plan-review-editor') as HTMLTextAreaElement

    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value',
      )!.set!
      nativeInputValueSetter.call(editor, '# Modified Plan')
      editor.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const approveBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => { approveBtn.click() })
    // The modified text should be passed (not undefined)
    expect(onApprove).toHaveBeenCalledWith('/tmp/project', '# Modified Plan')
  })

  test('updates editor when pendingPlan changes', async () => {
    const plan1 = makePlan({ planMd: 'Plan A' })
    const plan2 = makePlan({ planMd: 'Plan B' })

    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={plan1} onApprove={vi.fn()} onReject={vi.fn()} />,
      )
    })
    expect((container.querySelector('.plan-review-editor') as HTMLTextAreaElement).value).toBe('Plan A')

    await act(async () => {
      root.render(
        <PlanApprovalModal pendingPlan={plan2} onApprove={vi.fn()} onReject={vi.fn()} />,
      )
    })
    expect((container.querySelector('.plan-review-editor') as HTMLTextAreaElement).value).toBe('Plan B')
  })
})
