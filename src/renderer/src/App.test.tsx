import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSrc = readFileSync(resolve(__dirname, 'App.tsx'), 'utf-8')

describe('App navigation wiring', () => {
  test('Page type includes threads', () => {
    expect(appSrc).toMatch(/type Page\s*=.*'threads'/)
  })

  test('NAV_ITEMS includes threads entry between swarm and logs', () => {
    const navMatch = appSrc.match(/const NAV_ITEMS[\s\S]*?\n\]/)
    expect(navMatch).not.toBeNull()
    const navBlock = navMatch![0]

    expect(navBlock).toContain("id: 'threads'")
    expect(navBlock).toContain("label: 'Threads'")

    // Verify ordering: swarm before threads before logs
    const swarmIdx = navBlock.indexOf("id: 'swarm'")
    const threadsIdx = navBlock.indexOf("id: 'threads'")
    const logsIdx = navBlock.indexOf("id: 'logs'")
    expect(swarmIdx).toBeLessThan(threadsIdx)
    expect(threadsIdx).toBeLessThan(logsIdx)
  })

  test('ThreadsPage import is present', () => {
    expect(appSrc).toContain("import ThreadsPage from './pages/ThreadsPage'")
  })

  test('threads page renderer block exists with isEnabled gate', () => {
    expect(appSrc).toContain("current.page === 'threads' && current.isEnabled")
    expect(appSrc).toContain('<ThreadsPage')
  })

  test('mail page is fully removed', () => {
    expect(appSrc).not.toContain("'mail'")
    expect(appSrc).not.toContain('MailPage')
  })
})
