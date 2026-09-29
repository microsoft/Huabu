// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { HarnessDiscoveryParams, HarnessDiscoveryResult } from '@agentlet/protocol'
import { CUSTOM_COMMAND_WRAPPER_ID } from '@agentlet/protocol'
import { KNOWN_CLIS } from './catalogue.js'
import { Harness } from './harness.js'

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
  const ids = [...KNOWN_CLIS.map(({ id }) => id), CUSTOM_COMMAND_WRAPPER_ID]
  return { harnesses: await Promise.all(ids.map((id) => Harness.get(id).detect(options))) }
}
