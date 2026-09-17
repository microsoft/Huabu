import { execFile } from 'node:child_process'
import { constants as fsConstants, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import {
  MACHINE_CONTROL_LIMITS,
  type DiscoverHarnessesParams,
  type DiscoverHarnessesResult,
  type ValidateNativePathParams,
  type ValidateNativePathResult,
} from '@agentlet/protocol'

const execFileAsync = promisify(execFile)

export class MachineControlInputError extends Error {
  readonly code:
    | 'default_cwd_unavailable'
    | 'path_not_absolute'
    | 'path_not_found'
    | 'path_not_directory'

  constructor(code: MachineControlInputError['code'], message: string) {
    super(message)
    this.name = 'MachineControlInputError'
    this.code = code
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`)
  }
  if (value.includes('\0')) {
    throw new TypeError(`${field} must not contain NUL`)
  }
  return value
}

export function parseDiscoverHarnessesParams(
  value: unknown,
  platformName: NodeJS.Platform = process.platform,
): DiscoverHarnessesParams {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { harnesses?: unknown }).harnesses)
  ) {
    throw new TypeError('harnesses must be an array')
  }
  const harnesses = (value as { harnesses: unknown[] }).harnesses
  if (harnesses.length > MACHINE_CONTROL_LIMITS.maxHarnesses) {
    throw new TypeError(
      `harnesses exceeds ${MACHINE_CONTROL_LIMITS.maxHarnesses} entries`,
    )
  }
  const seen = new Set<string>()
  return {
    harnesses: harnesses.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new TypeError(`harnesses[${index}] must be an object`)
      }
      const candidate = entry as Record<string, unknown>
      const harnessId = requireBoundedString(
        candidate.harnessId,
        `harnesses[${index}].harnessId`,
        MACHINE_CONTROL_LIMITS.maxHarnessIdLength,
      )
      if (seen.has(harnessId)) {
        throw new TypeError(`Duplicate harnessId: ${harnessId}`)
      }
      seen.add(harnessId)
      const executable = requireBoundedString(
        candidate.executable,
        `harnesses[${index}].executable`,
        MACHINE_CONTROL_LIMITS.maxExecutableLength,
      )
      const pathModule = platformName === 'win32' ? win32 : posix
      const isAbsoluteExecutable = pathModule.isAbsolute(executable)
      if (
        !isAbsoluteExecutable &&
        (executable.includes('/') || executable.includes('\\'))
      ) {
        throw new TypeError(
          `harnesses[${index}].executable must be absolute or a bare executable name`,
        )
      }
      if (candidate.versionProbe === undefined) {
        return { harnessId, executable }
      }
      if (
        !candidate.versionProbe ||
        typeof candidate.versionProbe !== 'object'
      ) {
        throw new TypeError(
          `harnesses[${index}].versionProbe must be an object`,
        )
      }
      const probe = candidate.versionProbe as Record<string, unknown>
      if (
        !Array.isArray(probe.args) ||
        probe.args.length > MACHINE_CONTROL_LIMITS.maxProbeArgs
      ) {
        throw new TypeError(
          `harnesses[${index}].versionProbe.args must contain at most ${MACHINE_CONTROL_LIMITS.maxProbeArgs} strings`,
        )
      }
      const args = probe.args.map((arg, argIndex) =>
        requireBoundedString(
          arg,
          `harnesses[${index}].versionProbe.args[${argIndex}]`,
          MACHINE_CONTROL_LIMITS.maxProbeArgLength,
        ),
      )
      const timeoutMs = probe.timeoutMs
      if (
        timeoutMs !== undefined &&
        (!Number.isInteger(timeoutMs) ||
          (timeoutMs as number) < MACHINE_CONTROL_LIMITS.minProbeTimeoutMs ||
          (timeoutMs as number) > MACHINE_CONTROL_LIMITS.maxProbeTimeoutMs)
      ) {
        throw new TypeError(
          `harnesses[${index}].versionProbe.timeoutMs must be an integer between ${MACHINE_CONTROL_LIMITS.minProbeTimeoutMs} and ${MACHINE_CONTROL_LIMITS.maxProbeTimeoutMs}`,
        )
      }
      return {
        harnessId,
        executable,
        versionProbe: {
          args,
          ...(timeoutMs === undefined
            ? {}
            : { timeoutMs: timeoutMs as number }),
        },
      }
    }),
  }
}

export function parseValidateNativePathParams(
  value: unknown,
): ValidateNativePathParams {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('params must be an object')
  }
  const cwd = (value as Record<string, unknown>).cwd
  if (cwd === undefined) return {}
  return {
    cwd: requireBoundedString(cwd, 'cwd', MACHINE_CONTROL_LIMITS.maxPathLength),
  }
}

function executableNames(
  command: string,
  platformName: NodeJS.Platform,
): string[] {
  if (platformName !== 'win32' || win32.extname(command)) return [command]
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
  return [
    command,
    ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
  ]
}

export async function resolveExecutable(
  command: string,
  options: {
    platform?: NodeJS.Platform
    pathValue?: string
    canExecute?: (candidate: string) => Promise<boolean>
  } = {},
): Promise<string | undefined> {
  const platformName = options.platform ?? process.platform
  const canExecute =
    options.canExecute ??
    (async (candidate: string) => {
      try {
        await access(
          candidate,
          platformName === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
        )
        return !statSync(candidate).isDirectory()
      } catch {
        return false
      }
    })
  const pathModule = platformName === 'win32' ? win32 : posix
  if (pathModule.isAbsolute(command)) {
    return (await canExecute(command)) ? command : undefined
  }
  const pathSeparator = platformName === 'win32' ? ';' : ':'
  const directories = (options.pathValue ?? process.env.PATH ?? '').split(
    pathSeparator,
  )
  for (const directory of directories) {
    if (!directory) continue
    for (const name of executableNames(command, platformName)) {
      const candidate = pathModule.join(directory, name)
      if (await canExecute(candidate)) return candidate
    }
  }
  return undefined
}

export async function discoverHarnesses(
  params: DiscoverHarnessesParams,
  options: {
    resolve?: (command: string) => Promise<string | undefined>
    probe?: (
      executablePath: string,
      args: string[],
      timeoutMs: number,
    ) => Promise<string>
  } = {},
): Promise<DiscoverHarnessesResult> {
  const resolveCommand = options.resolve ?? resolveExecutable
  const probe =
    options.probe ??
    (async (executablePath, args, timeoutMs) => {
      const { stdout, stderr } = await execFileAsync(executablePath, args, {
        timeout: timeoutMs,
        maxBuffer: MACHINE_CONTROL_LIMITS.maxProbeOutputLength,
        windowsHide: true,
        encoding: 'utf8',
      })
      return `${stdout}${stderr}`
        .trim()
        .slice(0, MACHINE_CONTROL_LIMITS.maxProbeOutputLength)
    })
  return {
    harnesses: await Promise.all(
      params.harnesses.map(async (candidate) => {
        const executablePath = await resolveCommand(candidate.executable)
        if (!executablePath)
          return { harnessId: candidate.harnessId, status: 'missing' as const }
        if (!candidate.versionProbe) {
          return {
            harnessId: candidate.harnessId,
            status: 'installed' as const,
            executablePath,
          }
        }
        try {
          const version = await probe(
            executablePath,
            candidate.versionProbe.args,
            candidate.versionProbe.timeoutMs ??
              MACHINE_CONTROL_LIMITS.defaultProbeTimeoutMs,
          )
          return {
            harnessId: candidate.harnessId,
            status: 'installed' as const,
            executablePath,
            ...(version ? { version } : {}),
          }
        } catch (error) {
          return {
            harnessId: candidate.harnessId,
            status: 'probe_failed' as const,
            executablePath,
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, MACHINE_CONTROL_LIMITS.maxProbeOutputLength),
          }
        }
      }),
    ),
  }
}

export function validateNativePath(
  params: ValidateNativePathParams,
  options: {
    platform?: NodeJS.Platform
    home?: () => string
    stat?: (path: string) => { isDirectory(): boolean }
  } = {},
): ValidateNativePathResult {
  const platformName = options.platform ?? process.platform
  const pathModule = platformName === 'win32' ? win32 : posix
  const source = params.cwd === undefined ? 'default' : 'explicit'
  let candidate = params.cwd
  if (candidate === undefined) {
    try {
      candidate = (options.home ?? homedir)()
    } catch (error) {
      throw new MachineControlInputError(
        'default_cwd_unavailable',
        `Target machine home directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (!candidate || !pathModule.isAbsolute(candidate)) {
    if (source === 'default') {
      throw new MachineControlInputError(
        'default_cwd_unavailable',
        'Target machine home directory is unavailable or not absolute',
      )
    }
    throw new MachineControlInputError(
      'path_not_absolute',
      `cwd must be an absolute ${platformName === 'win32' ? 'Windows' : 'POSIX'} path`,
    )
  }
  const normalized = pathModule.normalize(candidate)
  let stats: { isDirectory(): boolean }
  try {
    stats = (options.stat ?? statSync)(normalized)
  } catch {
    throw new MachineControlInputError(
      source === 'default' ? 'default_cwd_unavailable' : 'path_not_found',
      source === 'default'
        ? `Target machine home directory is unavailable: ${normalized}`
        : `cwd does not exist on the target machine: ${normalized}`,
    )
  }
  if (!stats.isDirectory()) {
    throw new MachineControlInputError(
      source === 'default' ? 'default_cwd_unavailable' : 'path_not_directory',
      source === 'default'
        ? `Target machine home path is not a directory: ${normalized}`
        : `cwd is not a directory on the target machine: ${normalized}`,
    )
  }
  return { cwd: normalized, source }
}
