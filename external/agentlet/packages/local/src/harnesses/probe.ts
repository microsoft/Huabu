// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { isAbsolute, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessDiscoveryEntry, HarnessDiscoveryParams } from '@agentlet/protocol'
import type { KnownCli } from './catalogue.js'
import { prepareHarnessWorkspace } from './workspace.js'

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

export async function detectKnownHarness(
  { skipVersionProbe, ...cli }: KnownCli,
  options: HarnessDiscoveryParams,
): Promise<HarnessDiscoveryEntry> {
  const windows = platform() === 'win32'
  const entry: HarnessDiscoveryEntry = {
    ...cli,
    acpArgs: [...cli.acpArgs],
    autoApprove: cli.autoApprove ? { ...cli.autoApprove, args: [...cli.autoApprove.args] } : null,
    installed: false,
    launchPreviewVersion: 1,
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
}
