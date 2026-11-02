// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarnessDefinition } from './types.js'

function quoteTrustedPath(value: string): string {
  if (process.platform === 'win32') {
    if (/["%\r\n!]/.test(value)) throw new Error('Unsupported character in proxy installation path')
    return `"${value}"`
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function resolveProxyEntry(
  entry: string,
  resolveRealPath: (path: string) => string = realpathSync,
): string {
  return join(dirname(resolveRealPath(entry)), 'fs-proxy.js')
}

function proxyEntry(): string { return resolveProxyEntry(process.argv[1]!) }

export const proxyHarness: HarnessDefinition = {
  id: 'proxy', displayName: 'Filesystem Proxy', installHint: 'Included with Agentlet',
  capabilities: { customLaunchCommand: false, autoApprove: false },
  async discover() { return { status: existsSync(proxyEntry()) ? 'ready' : 'not-found' } },
  compile() {
    if (!existsSync(proxyEntry())) throw new Error('Bundled filesystem proxy is missing')
    const nodeMode = process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1"&& ' : 'ELECTRON_RUN_AS_NODE=1 '
    return { kind: 'shell', command: `${nodeMode}${quoteTrustedPath(process.execPath)} ${quoteTrustedPath(proxyEntry())}` }
  },
}
