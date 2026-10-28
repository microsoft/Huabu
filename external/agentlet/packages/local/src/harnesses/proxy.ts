// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarnessDefinition } from './types.js'

function quoteTrustedPath(value: string): string {
  if (process.platform === 'win32') {
    if (/["%\r\n!]/.test(value)) throw new Error('Unsupported character in proxy installation path')
    return `"${value}"`
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

function proxyEntry(): string { return join(dirname(process.argv[1]!), 'fs-proxy.js') }

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
