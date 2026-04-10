import { describe, test, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AgentOutputRenderer from './AgentOutputRenderer'

describe('AgentOutputRenderer', () => {
  test('renders empty output without error', () => {
    const html = renderToStaticMarkup(<AgentOutputRenderer output="" />)
    expect(html).toContain('sj-output')
  })

  test('renders plain text as raw segment', () => {
    const html = renderToStaticMarkup(<AgentOutputRenderer output="hello world" />)
    expect(html).toContain('sj-raw')
    expect(html).toContain('hello world')
  })

  test('renders assistant JSON as markdown block', () => {
    const input = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello from Claude' }] },
    })
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-assistant')
    expect(html).toContain('Hello from Claude')
  })

  test('renders tool_use segment', () => {
    const input = JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: '{"file": "test.ts"}',
    })
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-tool-use')
    expect(html).toContain('Read')
  })

  test('renders tool_result segment', () => {
    const input = JSON.stringify({
      type: 'tool_result',
      content: 'file contents here',
    })
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-tool-result')
    expect(html).toContain('Result')
  })

  test('renders tool_result error segment', () => {
    const input = JSON.stringify({
      type: 'tool_result',
      content: 'permission denied',
      is_error: true,
    })
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-tool-error')
    expect(html).toContain('Error')
  })

  test('renders system message', () => {
    const input = JSON.stringify({ type: 'system', message: 'System init' })
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-system')
    expect(html).toContain('System init')
  })

  test('renders result card with success', () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 3,
      result: 'Task completed',
      stop_reason: 'end_turn',
      session_id: 'sess-12345678',
      total_cost_usd: 0.05,
      modelUsage: {
        'claude-opus-4-20250514': {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
          costUSD: 0.05,
        },
      },
    })
    const html = renderToStaticMarkup(<AgentOutputRenderer output={result} />)
    expect(html).toContain('cr-success')
    expect(html).toContain('completed')
    expect(html).toContain('3 turns')
  })

  test('skips user messages', () => {
    const input = [
      JSON.stringify({ type: 'user', message: 'secret tool result content' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'visible' }] },
      }),
    ].join('\n')
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).not.toContain('secret tool result content')
    expect(html).toContain('visible')
  })

  test('merges consecutive assistant segments', () => {
    const input = [
      JSON.stringify({ type: 'assistant', message: 'First part' }),
      JSON.stringify({ type: 'assistant', message: 'Second part' }),
    ].join('\n')
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    // Both parts should be in a single assistant block
    const matches = html.match(/sj-assistant/g)
    expect(matches).toHaveLength(1)
    expect(html).toContain('First part')
    expect(html).toContain('Second part')
  })

  test('handles mixed segment types', () => {
    const input = [
      JSON.stringify({ type: 'assistant', message: 'Let me check' }),
      JSON.stringify({ type: 'tool_use', name: 'Bash', input: 'ls -la' }),
      JSON.stringify({ type: 'tool_result', content: 'file1.ts\nfile2.ts' }),
      JSON.stringify({ type: 'assistant', message: 'Found the files' }),
    ].join('\n')
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-assistant')
    expect(html).toContain('sj-tool-use')
    expect(html).toContain('sj-tool-result')
    expect(html).toContain('Bash')
  })

  test('skips verbose tool indicators', () => {
    const input = '▸ Read src/main.ts\n▸ Bash ls\nactual text'
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).not.toContain('▸ Read')
    expect(html).toContain('actual text')
  })

  test('handles malformed JSON gracefully as raw text', () => {
    const input = '{broken json\nsome text'
    const html = renderToStaticMarkup(<AgentOutputRenderer output={input} />)
    expect(html).toContain('sj-raw')
    expect(html).toContain('{broken json')
  })
})

describe('AgentOutputRenderer — memoization', () => {
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

  test('re-render with same output does not change DOM structure', async () => {
    const output = JSON.stringify({ type: 'assistant', message: 'Hello' })

    await act(async () => {
      root.render(<AgentOutputRenderer output={output} />)
    })
    const html1 = container.innerHTML

    await act(async () => {
      root.render(<AgentOutputRenderer output={output} />)
    })
    const html2 = container.innerHTML

    expect(html1).toBe(html2)
  })

  test('re-render with different output updates content', async () => {
    const output1 = JSON.stringify({ type: 'assistant', message: 'First' })
    const output2 = JSON.stringify({ type: 'assistant', message: 'Second' })

    await act(async () => {
      root.render(<AgentOutputRenderer output={output1} />)
    })
    expect(container.innerHTML).toContain('First')

    await act(async () => {
      root.render(<AgentOutputRenderer output={output2} />)
    })
    expect(container.innerHTML).toContain('Second')
    expect(container.innerHTML).not.toContain('First')
  })
})
