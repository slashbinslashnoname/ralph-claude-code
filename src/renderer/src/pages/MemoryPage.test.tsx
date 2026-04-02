import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import ReactDOM from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
  const mockCheck = vi.fn().mockResolvedValue({ installed: true })
  const mockContext = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      success: true,
      data: {
        task: 'test query',
        relevantBullets: [
          { id: 'b1', content: 'Always use strict mode', category: 'convention', score: 0.95 },
          { id: 'b2', content: 'Prefer const over let', category: 'convention', score: 0.8 },
        ],
        antiPatterns: [
          { id: 'ap1', content: 'Avoid var declarations', category: 'anti-pattern', score: 0.7 },
        ],
        historySnippets: [],
        deprecatedWarnings: [],
        suggestedCassQueries: ['cass search "test" --days 30'],
      },
      metadata: { executionMs: 42 },
    },
  })
  const mockSimilar = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      success: true,
      data: {
        query: 'test',
        mode: 'keyword',
        results: [
          { id: 's1', content: 'Use semantic versioning', score: 0.6 },
        ],
      },
      metadata: { executionMs: 15 },
    },
  })
  const mockStats = vi.fn().mockResolvedValue({ ok: true, data: {} })
  const mockTop = vi.fn().mockResolvedValue({ ok: true, data: {} })
  const mockSmCheck = vi.fn().mockResolvedValue({ installed: true })
  const mockSmContext = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      relevant_rules: [
        { id: 'r1', text: 'Always run tests before committing', category: 'workflow', confidence: 0.9 },
      ],
      anti_patterns: [
        { id: 'a1', text: 'Do not commit directly to main', category: 'git', confidence: 0.85 },
      ],
      history_snippets: [
        { id: 'h1', text: 'Fixed flaky test by adding retry logic' },
      ],
      rule_ids: ['r1', 'a1'],
    },
  })

  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).window.slashbot = {
    memory: {
      check: mockCheck,
      context: mockContext,
      similar: mockSimilar,
      stats: mockStats,
      top: mockTop,
      smCheck: mockSmCheck,
      smContext: mockSmContext,
    },
  }

  return { mockCheck, mockContext, mockSimilar, mockStats, mockTop, mockSmCheck, mockSmContext }
})

import MemoryPage from './MemoryPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockCheck.mockResolvedValue({ installed: true })
  mocks.mockSmCheck.mockResolvedValue({ installed: true })
})

describe('MemoryPage', () => {
  test('SSR renders loading state (useEffect has not run)', () => {
    const html = renderToStaticMarkup(<MemoryPage projectPath="/test" />)
    expect(html).toContain('Loading')
  })
})

describe('MemoryPage — interactive', () => {
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

  test('renders Memory header, search input, and mode tabs after mount', async () => {
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})
    expect(container.innerHTML).toContain('Memory')
    expect(container.querySelector('input')).not.toBeNull()
    expect(container.innerHTML).toContain('>Search</button>')
    expect(container.innerHTML).toContain('>Context</button>')
    expect(container.innerHTML).toContain('>Similar</button>')
    expect(container.innerHTML).toContain('>Slashmem</button>')
  })

  test('shows not-installed state when neither CLI is available', async () => {
    mocks.mockCheck.mockResolvedValue({ installed: false })
    mocks.mockSmCheck.mockResolvedValue({ installed: false })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})
    expect(container.innerHTML).toContain('No memory CLI is installed')
  })

  test('shows only Slashmem tab when cm is not installed but sm is', async () => {
    mocks.mockCheck.mockResolvedValue({ installed: false })
    mocks.mockSmCheck.mockResolvedValue({ installed: true })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})
    expect(container.innerHTML).not.toContain('>Context</button>')
    expect(container.innerHTML).not.toContain('>Similar</button>')
    expect(container.innerHTML).toContain('>Slashmem</button>')
  })

  test('shows only cm tabs when sm is not installed', async () => {
    mocks.mockCheck.mockResolvedValue({ installed: true })
    mocks.mockSmCheck.mockResolvedValue({ installed: false })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})
    expect(container.innerHTML).toContain('>Context</button>')
    expect(container.innerHTML).toContain('>Similar</button>')
    expect(container.innerHTML).not.toContain('>Slashmem</button>')
  })

  test('context search displays relevant bullets and anti-patterns', async () => {
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    // Type query
    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'test query')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click search
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(mocks.mockContext).toHaveBeenCalledWith('/test', 'test query')
    expect(container.innerHTML).toContain('Relevant Rules (2)')
    expect(container.innerHTML).toContain('Always use strict mode')
    expect(container.innerHTML).toContain('Anti-Patterns (1)')
    expect(container.innerHTML).toContain('Avoid var declarations')
    expect(container.innerHTML).toContain('42ms')
  })

  test('similar search displays results', async () => {
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    // Switch to Similar mode
    const similarBtn = Array.from(container.querySelectorAll('.memory-mode-tabs button'))
      .find(b => b.textContent === 'Similar') as HTMLButtonElement
    await act(async () => {
      similarBtn.click()
    })

    // Type query
    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'test')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click search
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(mocks.mockSimilar).toHaveBeenCalledWith('/test', 'test')
    expect(container.innerHTML).toContain('Similar Bullets (1)')
    expect(container.innerHTML).toContain('Use semantic versioning')
  })

  test('slashmem search displays rules, anti-patterns, and snippets', async () => {
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    // Switch to Slashmem mode
    const smBtn = Array.from(container.querySelectorAll('.memory-mode-tabs button'))
      .find(b => b.textContent === 'Slashmem') as HTMLButtonElement
    await act(async () => {
      smBtn.click()
    })

    // Type query
    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'testing workflow')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click search
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(mocks.mockSmContext).toHaveBeenCalledWith('/test', 'testing workflow')
    expect(container.innerHTML).toContain('Relevant Rules (1)')
    expect(container.innerHTML).toContain('Always run tests before committing')
    expect(container.innerHTML).toContain('Anti-Patterns (1)')
    expect(container.innerHTML).toContain('Do not commit directly to main')
    expect(container.innerHTML).toContain('History Snippets (1)')
    expect(container.innerHTML).toContain('Fixed flaky test by adding retry logic')
  })

  test('shows error when slashmem search fails', async () => {
    mocks.mockSmContext.mockResolvedValue({ ok: false, error: 'sm crashed' })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    // Switch to Slashmem mode
    const smBtn = Array.from(container.querySelectorAll('.memory-mode-tabs button'))
      .find(b => b.textContent === 'Slashmem') as HTMLButtonElement
    await act(async () => {
      smBtn.click()
    })

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'fail query')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(container.innerHTML).toContain('sm crashed')
    expect(container.querySelector('.memory-error')).not.toBeNull()
  })

  test('shows error when context search fails', async () => {
    mocks.mockContext.mockResolvedValue({ ok: false, error: 'cm crashed' })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'fail query')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(container.innerHTML).toContain('cm crashed')
    expect(container.querySelector('.memory-error')).not.toBeNull()
  })

  test('shows empty state when no results found', async () => {
    mocks.mockContext.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        data: {
          task: 'nothing',
          relevantBullets: [],
          antiPatterns: [],
          historySnippets: [],
          deprecatedWarnings: [],
          suggestedCassQueries: [],
        },
        metadata: { executionMs: 5 },
      },
    })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'nothing')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(container.innerHTML).toContain('No results found')
  })

  test('shows empty state when slashmem returns no results', async () => {
    mocks.mockSmContext.mockResolvedValue({
      ok: true,
      data: {
        relevant_rules: [],
        anti_patterns: [],
        history_snippets: [],
        rule_ids: [],
      },
    })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    const smBtn = Array.from(container.querySelectorAll('.memory-mode-tabs button'))
      .find(b => b.textContent === 'Slashmem') as HTMLButtonElement
    await act(async () => {
      smBtn.click()
    })

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'nothing')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(container.innerHTML).toContain('No results found')
  })

  test('search button is disabled when query is empty', async () => {
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    expect(searchBtn.disabled).toBe(true)
  })

  test('displays suggested queries from context search', async () => {
    mocks.mockContext.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        data: {
          task: 'test query',
          relevantBullets: [
            { id: 'b1', content: 'Always use strict mode', category: 'convention', score: 0.95 },
          ],
          antiPatterns: [],
          historySnippets: [],
          deprecatedWarnings: [],
          suggestedCassQueries: ['cass search "test" --days 30'],
        },
        metadata: { executionMs: 42 },
      },
    })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'test query')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(container.innerHTML).toContain('Suggested Queries')
    expect(container.innerHTML).toContain('cass search')
  })

  test('displays bullet feedback counts', async () => {
    mocks.mockContext.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        data: {
          task: 'test',
          relevantBullets: [
            { id: 'fb1', content: 'rule with feedback', feedback: { helpful: 5, harmful: 2 } },
          ],
          antiPatterns: [],
          historySnippets: [],
          deprecatedWarnings: [],
          suggestedCassQueries: [],
        },
        metadata: { executionMs: 10 },
      },
    })
    await act(async () => {
      root.render(<MemoryPage projectPath="/test" />)
    })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'test')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => {
      searchBtn.click()
    })
    await act(async () => {})

    expect(container.innerHTML).toContain('+5')
    expect(container.innerHTML).toContain('-2')
  })
})

describe('memory namespace (preload bridge)', () => {
  test('memory.check returns installed status', async () => {
    const result = await window.slashbot.memory.check()
    expect(result).toEqual({ installed: true })
    expect(mocks.mockCheck).toHaveBeenCalledTimes(1)
  })

  test('memory.context sends project path and query', async () => {
    await window.slashbot.memory.context('/my/project', 'find bugs')
    expect(mocks.mockContext).toHaveBeenCalledWith('/my/project', 'find bugs')
  })

  test('memory.similar sends project path and query', async () => {
    await window.slashbot.memory.similar('/my/project', 'testing patterns')
    expect(mocks.mockSimilar).toHaveBeenCalledWith('/my/project', 'testing patterns')
  })

  test('memory.stats sends project path', async () => {
    await window.slashbot.memory.stats('/my/project')
    expect(mocks.mockStats).toHaveBeenCalledWith('/my/project')
  })

  test('memory.top sends project path and count', async () => {
    await window.slashbot.memory.top('/my/project', 5)
    expect(mocks.mockTop).toHaveBeenCalledWith('/my/project', 5)
  })

  test('memory.smCheck returns installed status', async () => {
    const result = await window.slashbot.memory.smCheck()
    expect(result).toEqual({ installed: true })
    expect(mocks.mockSmCheck).toHaveBeenCalledTimes(1)
  })

  test('memory.smContext sends project path and query', async () => {
    await window.slashbot.memory.smContext('/my/project', 'workflow rules')
    expect(mocks.mockSmContext).toHaveBeenCalledWith('/my/project', 'workflow rules')
  })
})
