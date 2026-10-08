import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { isAbsolute, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessDiagnostic, HarnessDiscovery } from '../types.js'

const execFileP = promisify(execFile)
const PROBE_OPTIONS = {
  timeout: 2_500,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 64 * 1024,
  windowsHide: true,
  shell: false,
}
const WINDOWS_SHELL_EXTENSIONS = /\.(?:exe|com|cmd|bat)$/i

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missingLookup(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 1 && !('killed' in error && error.killed)
}

async function locateCommand(command: string): Promise<boolean> {
  const windows = platform() === 'win32'
  const { stdout } = await execFileP(windows ? 'where.exe' : 'which', [command], PROBE_OPTIONS)
  return stdout.split(/\r?\n/).some((candidate) => {
    const path = candidate.trim()
    if (!path) return false
    if (windows) return win32.isAbsolute(path) && WINDOWS_SHELL_EXTENSIONS.test(path)
    return isAbsolute(path)
  })
}

async function probeVersion(command: string): Promise<string | undefined> {
  if (platform() === 'win32') {
    const shell = process.env.ComSpec || 'cmd.exe'
    const { stdout } = await execFileP(shell, ['/d', '/s', '/c', `${command} --version`], PROBE_OPTIONS)
    return stdout.split(/\r?\n/)[0]?.trim() || undefined
  }
  const { stdout } = await execFileP(command, ['--version'], PROBE_OPTIONS)
  return stdout.split(/\r?\n/)[0]?.trim() || undefined
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    return await locateCommand(command)
  } catch {
    return false
  }
}

export async function discoverCommand(
  command: string,
  options: { probeVersion?: boolean } = {},
): Promise<HarnessDiscovery> {
  const diagnostics: HarnessDiagnostic[] = []
  try {
    if (!await locateCommand(command)) {
      return {
        status: 'not-found',
        diagnostics: [{ code: 'lookup_failed', message: 'PATH lookup returned no platform-shell command' }],
      }
    }
  } catch (error) {
    return {
      status: 'not-found',
      diagnostics: [{
        code: missingLookup(error) ? 'binary_missing' : 'lookup_failed',
        message: missingLookup(error) ? `${command} is not on PATH` : message(error),
      }],
    }
  }
  if (options.probeVersion === false) return { status: 'ready' }
  try {
    const version = await probeVersion(command)
    if (version) return { status: 'ready', version }
    diagnostics.push({ code: 'version_unknown', message: 'Version probe returned no version' })
  } catch (error) {
    diagnostics.push({ code: 'version_probe_failed', message: message(error) })
  }
  return { status: 'ready', diagnostics }
}
