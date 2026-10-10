// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { HarnessDiscoveryParams, HarnessDiscoveryResult } from '@agentlet/protocol'
import { HARNESS_DEFINITIONS } from './registry.js'
import { prepareHarnessWorkspace } from './workspace.js'

export function parseHarnessDiscoveryParams(params: unknown): HarnessDiscoveryParams {
  if (params === undefined) return {}
  if (
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => key !== 'prepareWorkspaces') ||
    ('prepareWorkspaces' in params && typeof params.prepareWorkspaces !== 'boolean')
  ) {
    throw new Error('Expected only optional boolean prepareWorkspaces')
  }
  return params as HarnessDiscoveryParams
}

/** Probe only the daemon's trusted catalogue; no install, bootstrap, or credential changes. */
export async function discoverHarnesses(params: HarnessDiscoveryParams = {}): Promise<HarnessDiscoveryResult> {
  const options = parseHarnessDiscoveryParams(params)
  return {
    harnesses: await Promise.all(HARNESS_DEFINITIONS.map(async (definition) => {
      const observation = await definition.discover()
      const diagnostics = [...(observation.diagnostics ?? [])]
      let workingDirPath: string | undefined
      if (options.prepareWorkspaces && observation.status === 'ready' && definition.id !== 'custom') {
        try {
          workingDirPath = await prepareHarnessWorkspace(definition.id)
        } catch (error) {
          diagnostics.push({
            code: 'workspace_failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return {
        id: definition.id,
        displayName: definition.displayName,
        installHint: definition.installHint,
        capabilities: { ...definition.capabilities },
        status: observation.status,
        ...(observation.version ? { version: observation.version } : {}),
        ...(workingDirPath ? { workingDirPath } : {}),
        ...(diagnostics.length ? { diagnostics } : {}),
      }
    })),
  }
}
