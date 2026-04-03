import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import ReactDOM from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => {
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
        'Fixed flaky test by adding retry logic',
      ],
      rule_ids: ['r1', 'a1'],
    },
  })
  const mockSmStatus = vi.fn().mockResolvedValue({
    ok: true,
    data: { ok: true, db_path: '/test/mem.db', counts: { episodic: 5, working: 3, procedural: 8 }, schema_version: 1 },
  })
  const mockSmProjects = vi.fn().mockResolvedValue({
    ok: true,
    data: { projects: [{ name: 'abc123', path: '/test/project', db_path: '/test/mem.db' }] },
  })
  const mockSmRulesList = vi.fn().mockResolvedValue({ ok: true, data: { rules: [], count: 0 } })
  const mockSmRulesShow = vi.fn().mockResolvedValue({ ok: true, data: {} })
  const mockSmRulesAdd = vi.fn().mockResolvedValue({ ok: true, data: { id: 'test', created: true } })
  const mockSmRulesRm = vi.fn().mockResolvedValue({ ok: true, data: { id: 'test', deleted: true } })
  const mockSmDistill = vi.fn().mockResolvedValue({ ok: true, data: { decayed: 0, pruned: 0, transitioned: 0 } })
  const mockSmIngest = vi.fn().mockResolvedValue({ ok: true, data: { episodic_id: 1, proposed_rules: [], validated_rules: [] } })

  if (typeof (globalThis as any).window === 'undefined') {
    ;(globalThis as any).window = {}
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as any).window.slashbot = {
    memory: {
      smCheck: mockSmCheck,
      smContext: mockSmContext,
      smStatus: mockSmStatus,
      smProjects: mockSmProjects,
      smRulesList: mockSmRulesList,
      smRulesShow: mockSmRulesShow,
      smRulesAdd: mockSmRulesAdd,
      smRulesRm: mockSmRulesRm,
      smDistill: mockSmDistill,
      smIngest: mockSmIngest,
    },
  }

  return {
    mockSmCheck, mockSmContext, mockSmStatus, mockSmProjects,
    mockSmRulesList, mockSmRulesShow, mockSmRulesAdd, mockSmRulesRm,
    mockSmDistill, mockSmIngest,
  }
})

import MemoryPage from './MemoryPage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.mockSmCheck.mockResolvedValue({ installed: true })
  mocks.mockSmStatus.mockResolvedValue({
    ok: true,
    data: { ok: true, db_path: '/test/mem.db', counts: { episodic: 5, working: 3, procedural: 8 }, schema_version: 1 },
  })
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

  test('renders Memory header, search input, and tabs after mount', async () => {
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})
    expect(container.innerHTML).toContain('Memory')
    expect(container.querySelector('input')).not.toBeNull()
    expect(container.innerHTML).toContain('>Search</button>')
    expect(container.innerHTML).toContain('>Context</button>')
    expect(container.innerHTML).toContain('>Rules</button>')
    expect(container.innerHTML).toContain('>Projects</button>')
    expect(container.innerHTML).toContain('>Ingest</button>')
  })

  test('renders status bar with counts', async () => {
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})
    expect(container.innerHTML).toContain('8')
    expect(container.innerHTML).toContain('rules')
    expect(container.innerHTML).toContain('5')
    expect(container.innerHTML).toContain('episodes')
  })

  test('shows not-installed state when sm is not available', async () => {
    mocks.mockSmCheck.mockResolvedValue({ installed: false })
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})
    expect(container.innerHTML).toContain('Slashmem is not installed')
  })

  test('context search displays rules, anti-patterns, and snippets', async () => {
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'testing workflow')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => { searchBtn.click() })
    await act(async () => {})

    expect(mocks.mockSmContext).toHaveBeenCalledWith('/test', 'testing workflow')
    expect(container.innerHTML).toContain('Always run tests before committing')
    expect(container.innerHTML).toContain('Do not commit directly to main')
    expect(container.innerHTML).toContain('Fixed flaky test by adding retry logic')
  })

  test('shows error when search fails', async () => {
    mocks.mockSmContext.mockResolvedValue({ ok: false, error: 'sm crashed' })
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'fail query')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => { searchBtn.click() })
    await act(async () => {})

    expect(container.innerHTML).toContain('sm crashed')
    expect(container.querySelector('.memory-error')).not.toBeNull()
  })

  test('shows empty state when no results found', async () => {
    mocks.mockSmContext.mockResolvedValue({
      ok: true,
      data: { relevant_rules: [], anti_patterns: [], history_snippets: [], rule_ids: [] },
    })
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})

    const input = container.querySelector('input') as HTMLInputElement
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      nativeSetter.call(input, 'nothing')
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => { searchBtn.click() })
    await act(async () => {})

    expect(container.innerHTML).toContain('No results')
  })

  test('search button is disabled when query is empty', async () => {
    await act(async () => { root.render(<MemoryPage projectPath="/test" />) })
    await act(async () => {})

    const searchBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    expect(searchBtn.disabled).toBe(true)
  })
})

describe('memory namespace (preload bridge)', () => {
  test('memory.smCheck returns installed status', async () => {
    const result = await window.slashbot.memory.smCheck()
    expect(result).toEqual({ installed: true })
    expect(mocks.mockSmCheck).toHaveBeenCalledTimes(1)
  })

  test('memory.smContext sends project path and query', async () => {
    await window.slashbot.memory.smContext('/my/project', 'workflow rules')
    expect(mocks.mockSmContext).toHaveBeenCalledWith('/my/project', 'workflow rules')
  })

  test('memory.smStatus sends project path', async () => {
    await window.slashbot.memory.smStatus('/my/project')
    expect(mocks.mockSmStatus).toHaveBeenCalledWith('/my/project')
  })

  test('memory.smRulesList sends project path and optional query', async () => {
    await window.slashbot.memory.smRulesList('/my/project', 'deploy')
    expect(mocks.mockSmRulesList).toHaveBeenCalledWith('/my/project', 'deploy')
  })

  test('memory.smRulesAdd sends all params', async () => {
    await window.slashbot.memory.smRulesAdd('/my/project', 'test-rule', 'Always test', 'postmortem')
    expect(mocks.mockSmRulesAdd).toHaveBeenCalledWith('/my/project', 'test-rule', 'Always test', 'postmortem')
  })

  test('memory.smDistill sends project path', async () => {
    await window.slashbot.memory.smDistill('/my/project')
    expect(mocks.mockSmDistill).toHaveBeenCalledWith('/my/project')
  })

  test('memory.smIngest sends all params', async () => {
    await window.slashbot.memory.smIngest('/my/project', 'TASK-1', 'Done', 'agent-0', ['r1'], ['r2'])
    expect(mocks.mockSmIngest).toHaveBeenCalledWith('/my/project', 'TASK-1', 'Done', 'agent-0', ['r1'], ['r2'])
  })
})
