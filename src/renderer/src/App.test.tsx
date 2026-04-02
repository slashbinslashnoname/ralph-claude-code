import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSrc = readFileSync(resolve(__dirname, 'App.tsx'), 'utf-8')

describe('App navigation wiring', () => {
  test('threads page is fully removed', () => {
    expect(appSrc).not.toContain("'threads'")
    expect(appSrc).not.toContain('ThreadsPage')
  })

  test('mail page is fully removed', () => {
    expect(appSrc).not.toContain("'mail'")
    expect(appSrc).not.toContain('MailPage')
  })
})
