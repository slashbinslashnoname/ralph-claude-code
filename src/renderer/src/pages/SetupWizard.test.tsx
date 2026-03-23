import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(__dirname, 'SetupWizard.tsx'), 'utf-8')

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
