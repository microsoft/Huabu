import type { CompiledHarnessLaunch } from '../types.js'

const TRUSTED_COMMAND_TOKEN = /^[A-Za-z0-9@%_./:=+-]+$/

export function compileTrustedCommand(tokens: readonly string[]): CompiledHarnessLaunch {
  if (!tokens.length || tokens.some((token) => !TRUSTED_COMMAND_TOKEN.test(token))) {
    throw new Error('Harness command contains an unsafe token')
  }
  return { kind: 'shell', command: tokens.join(' ') }
}
