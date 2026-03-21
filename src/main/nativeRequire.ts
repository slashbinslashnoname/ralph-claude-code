import { createRequire } from 'module'

/**
 * Creates a require function safe for loading native modules from ASAR-unpacked.
 *
 * In packaged Electron apps, import.meta.url may resolve to an asar:// protocol
 * path that breaks createRequire for native addons. This helper tries the URL-based
 * approach first, then falls back to __filename (always available in CJS output from
 * electron-vite).
 */
export function createNativeRequire(
  metaUrl: string | undefined = import.meta.url,
  fallbackPath: string = __filename,
): NodeRequire {
  // Try import.meta.url first (standard approach)
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      const req = createRequire(metaUrl)
      // Verify the require function works by resolving a known built-in
      req.resolve('module')
      return req
    } catch {
      // import.meta.url may be an unsupported protocol (e.g. asar://)
    }
  }

  // Fallback to __filename (always defined in CJS, which electron-vite outputs)
  return createRequire(fallbackPath)
}

/** Known native modules that must appear in electron-builder's asarUnpack */
export const NATIVE_MODULES = ['node-pty', 'fsevents'] as const
