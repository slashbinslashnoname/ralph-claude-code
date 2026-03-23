import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSrc = readFileSync(resolve(__dirname, 'App.tsx'), 'utf-8')

describe('App navigation wiring', () => {
  test('Page type includes mail', () => {
    expect(appSrc).toMatch(/type Page\s*=.*'mail'/)
  })

  test('NAV_ITEMS includes mail entry between swarm and logs', () => {
    const navMatch = appSrc.match(/const NAV_ITEMS[\s\S]*?\n\]/)
    expect(navMatch).not.toBeNull()
    const navBlock = navMatch![0]

    expect(navBlock).toContain("id: 'mail'")
    expect(navBlock).toContain("label: 'Mail'")

    // Verify ordering: swarm before mail before logs
    const swarmIdx = navBlock.indexOf("id: 'swarm'")
    const mailIdx = navBlock.indexOf("id: 'mail'")
    const logsIdx = navBlock.indexOf("id: 'logs'")
    expect(swarmIdx).toBeLessThan(mailIdx)
    expect(mailIdx).toBeLessThan(logsIdx)
  })

  test('MailPage import is present', () => {
    expect(appSrc).toContain("import MailPage from './pages/MailPage'")
  })

  test('mail page renderer block exists with isEnabled gate', () => {
    expect(appSrc).toContain("current.page === 'mail' && current.isEnabled && <MailPage")
  })
})
