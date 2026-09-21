// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { isAbsolute, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessDiscoveryEntry, HarnessDiscoveryParams, HarnessDiscoveryResult } from '@agentlet/protocol'
import { KNOWN_CLIS } from './catalogue.js'
import { prepareHarnessWorkspace } from './workspace.js'
import { Harness } from './harness.js'

const execFileP = promisify(execFile)
const PROBE_OPTIONS = {
  timeout: 2_500,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 64 * 1024,
  windowsHide: true,
  shell: false,
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  const windows = platform() === 'win32'
  const harnesses = await Promise.all(
    KNOWN_CLIS.map(async ({ skipVersionProbe, ...cli }): Promise<HarnessDiscoveryEntry> => {
      const entry: HarnessDiscoveryEntry = {
        ...cli,
        acpArgs: [...cli.acpArgs],
        autoApprove: cli.autoApprove ? { ...cli.autoApprove, args: [...cli.autoApprove.args] } : null,
        installed: false,
        capabilities: Harness.get(cli.id).describeCapabilities(),
      }
      const diagnose = (code: string, detail: string) => {
        ;(entry.diagnostics ??= []).push({ code, message: detail })
      }
      try {
        const { stdout } = await execFileP(windows ? 'where.exe' : 'which', [cli.binary], PROBE_OPTIONS)
        const executablePath = stdout.split(/\r?\n/)[0]?.trim()
        if (!executablePath || !(windows ? win32.isAbsolute(executablePath) : isAbsolute(executablePath))) {
          diagnose('lookup_failed', 'PATH lookup did not return an absolute executable path')
          return entry
        }
        entry.executablePath = executablePath
        entry.installed = true
        // Windows npm shims require a shell; only native executables opt into typed launch.
        if (!windows || /\.(exe|com)$/i.test(executablePath)) entry.launchVersion = 1
      } catch (error) {
        const missing = typeof error === 'object' && error !== null &&
          'code' in error && error.code === 1 && !('killed' in error && error.killed)
        diagnose(missing ? 'binary_missing' : 'lookup_failed', missing ? `${cli.binary} is not on PATH` : message(error))
        return entry
      }

      if (!skipVersionProbe) {
        try {
          const { stdout } = await execFileP(entry.executablePath!, ['--version'], PROBE_OPTIONS)
          const version = stdout.split(/\r?\n/)[0]?.trim()
          if (version) entry.version = version
          else diagnose('version_unknown', 'Version probe returned no version')
        } catch (error) {
          diagnose('version_probe_failed', message(error))
        }
      }
      if (options.prepareWorkspaces) {
        try {
          entry.workingDirPath = await prepareHarnessWorkspace(cli.id)
        } catch (error) {
          diagnose('workspace_failed', message(error))
        }
      }
      return entry
    }),
  )
  return { harnesses }
}
