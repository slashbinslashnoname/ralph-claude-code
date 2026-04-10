import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import ReactDOM from 'react-dom/client'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, 'SetupWizard.tsx'), 'utf-8')

const mocks = vi.hoisted(() => {
  const mockInstallCheck = vi.fn().mockResolvedValue({ installed: true })
  const mockEnable = vi.fn().mockResolvedValue({ ok: true, filesCreated: ['a', 'b'], storeDir: '/home/.slashbot/projects/test' })

  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).window.slashbot = {
    beads: { installCheck: mockInstallCheck },
    enable: mockEnable,
  }

  return { mockInstallCheck, mockEnable }
})

import SetupWizard from './SetupWizard'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockInstallCheck.mockResolvedValue({ installed: true })
  mocks.mockEnable.mockResolvedValue({ ok: true, filesCreated: ['a', 'b'], storeDir: '/home/.slashbot/projects/test' })
})

describe('SetupWizard centralized storage display', () => {
  test('shows storeDir when present in enable result', () => {
    expect(src).toContain('result.storeDir')
  })

  test('storeDir is rendered inside a code element', () => {
    expect(src).toMatch(/<code>\{result\.storeDir\}<\/code>/)
  })

  test('centralized storage path entry listed in setup files', () => {
    expect(src).toContain('~/.slashbot/projects/')
  })

  test('success block is conditional on result.ok', () => {
    expect(src).toContain('result?.ok')
  })

  test('storeDir block is conditional to avoid showing undefined', () => {
    expect(src).toContain('result.storeDir &&')
  })
})

describe('SetupWizard timeout handling', () => {
  test('defines BD_CHECK_TIMEOUT_MS constant', () => {
    expect(src).toContain('BD_CHECK_TIMEOUT_MS')
  })

  test('defines ENABLE_TIMEOUT_MS constant', () => {
    expect(src).toContain('ENABLE_TIMEOUT_MS')
  })

  test('wraps installCheck with withTimeout', () => {
    expect(src).toMatch(/withTimeout\(sb\.beads\.installCheck\(\),\s*BD_CHECK_TIMEOUT_MS/)
  })

  test('wraps enable call with withTimeout', () => {
    expect(src).toMatch(/withTimeout\(\s*sb\.enable\(/)
  })

  test('withTimeout rejects with descriptive timeout message', () => {
    expect(src).toContain('timed out after')
  })
})

describe('SetupWizard bd check error recovery', () => {
  test('tracks bdCheckError state', () => {
    expect(src).toContain('bdCheckError')
  })

  test('shows error message when bd check fails', () => {
    expect(src).toContain('Failed to check bd CLI:')
  })

  test('offers Retry button on bd check error', () => {
    expect(src).toMatch(/bdCheckError[\s\S]*?Retry/)
  })

  test('offers Skip beads button on bd check error', () => {
    expect(src).toMatch(/bdCheckError[\s\S]*?Skip beads/)
  })

  test('offers Skip beads button when bd not found', () => {
    expect(src).toMatch(/bdInstalled === false[\s\S]*?Skip beads/)
  })
})

describe('SetupWizard enable error recovery', () => {
  test('tracks enableError state', () => {
    expect(src).toContain('enableError')
  })

  test('shows error with Setup failed label', () => {
    expect(src).toContain('Setup failed:')
  })

  test('offers Back button on enable failure', () => {
    // In the enable error block there should be a Back button
    expect(src).toMatch(/enableError[\s\S]*?Back[\s\S]*?Retry/)
  })

  test('offers Retry button on enable failure', () => {
    expect(src).toMatch(/enableError[\s\S]*?onClick=\{run\}/)
  })

  test('catches timeout errors from enable call', () => {
    expect(src).toContain('catch (err)')
  })
})

describe('SetupWizard — DOM interaction', () => {
  let container: HTMLElement
  let root: ReturnType<typeof ReactDOM.createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = ReactDOM.createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    document.body.removeChild(container)
  })

  test('bd check timeout shows Retry and Skip beads buttons', async () => {
    mocks.mockInstallCheck.mockImplementation(
      () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('bd CLI check timed out after 10s')), 50)
      }),
    )

    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    // Wait for the timeout rejection to fire
    await act(async () => { await new Promise(r => setTimeout(r, 100)) })

    // Should show error alert with Retry and Skip beads buttons
    const alert = container.querySelector('.alert-danger')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('Failed to check bd CLI:')
    expect(alert!.textContent).toContain('timed out')

    const buttons = alert!.querySelectorAll('button')
    const labels = Array.from(buttons).map(b => b.textContent)
    expect(labels).toContain('Retry')
    expect(labels).toContain('Skip beads')
  })

  test('Retry button re-triggers bd check after timeout error', async () => {
    let callCount = 0
    mocks.mockInstallCheck.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('timed out')), 50)
        })
      }
      return Promise.resolve({ installed: true })
    })

    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    await act(async () => { await new Promise(r => setTimeout(r, 100)) })

    // Click Retry
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Retry',
    ) as HTMLButtonElement
    expect(retryBtn).not.toBeUndefined()
    await act(async () => { retryBtn.click() })
    await act(async () => {})

    // Error should clear, success alert should appear
    expect(container.querySelector('.alert-danger')).toBeNull()
    expect(container.querySelector('.alert-success')).not.toBeNull()
    expect(container.textContent).toContain('bd CLI detected')
  })

  test('invalid maxCallsPerHour does not prevent Continue (no inline validation)', async () => {
    // SetupWizard uses a plain number input with min/max attributes but no
    // inline validation that disables Continue — canContinue only checks bd status.
    // Verify that Continue is enabled when bd is installed, regardless of input value.
    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    await act(async () => {})

    // Set maxCalls to an out-of-range value
    const numberInput = container.querySelector('input[type="number"]') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(numberInput, '0')
      numberInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Continue button should still be enabled (canContinue depends on bd, not maxCalls)
    const continueBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Continue',
    ) as HTMLButtonElement
    expect(continueBtn).not.toBeUndefined()
    expect(continueBtn.disabled).toBe(false)
  })

  test('Continue button disabled when useBeads is on and bd is not installed', async () => {
    mocks.mockInstallCheck.mockResolvedValue({ installed: false })

    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    await act(async () => {})

    const continueBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Continue',
    ) as HTMLButtonElement
    expect(continueBtn.disabled).toBe(true)
  })

  test('Continue button enabled when useBeads is unchecked', async () => {
    mocks.mockInstallCheck.mockResolvedValue({ installed: false })

    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    await act(async () => {})

    // Uncheck useBeads
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => {
      checkbox.click()
    })
    await act(async () => {})

    const continueBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Continue',
    ) as HTMLButtonElement
    expect(continueBtn.disabled).toBe(false)
  })

  test('Step 1 shows Initialize button and enables proceed to setup', async () => {
    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    await act(async () => {})

    // Click Continue to go to step 1
    const continueBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Continue',
    ) as HTMLButtonElement
    await act(async () => { continueBtn.click() })
    await act(async () => {})

    expect(container.textContent).toContain('Ready to initialize')
    const initBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Initialize',
    ) as HTMLButtonElement
    expect(initBtn).not.toBeUndefined()
    expect(initBtn.disabled).toBe(false)
  })

  test('enable failure shows Setup failed with Back and Retry buttons', async () => {
    mocks.mockEnable.mockRejectedValue(new Error('Project setup timed out after 30s'))

    await act(async () => {
      root.render(<SetupWizard projectPath="/tmp/test" onComplete={vi.fn()} />)
    })
    await act(async () => {})

    // Navigate to step 1
    const continueBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Continue',
    ) as HTMLButtonElement
    await act(async () => { continueBtn.click() })
    await act(async () => {})

    // Click Initialize
    const initBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Initialize',
    ) as HTMLButtonElement
    await act(async () => { initBtn.click() })
    await act(async () => {})

    expect(container.textContent).toContain('Setup failed:')
    expect(container.textContent).toContain('timed out after 30s')

    const errorButtons = container.querySelector('.alert-danger')!.querySelectorAll('button')
    const labels = Array.from(errorButtons).map(b => b.textContent)
    expect(labels).toContain('Back')
    expect(labels).toContain('Retry')
  })
})
