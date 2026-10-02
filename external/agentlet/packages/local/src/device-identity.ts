import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

interface DeviceIdentityFile {
  version: 1
  deviceId: string
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function defaultDeviceIdentityPath(): string {
  return join(homedir(), '.agentlet', 'device.json')
}

function parseDeviceIdentity(path: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `Agentlet device identity is unreadable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<DeviceIdentityFile>).version !== 1 ||
    typeof (parsed as Partial<DeviceIdentityFile>).deviceId !== 'string' ||
    !UUID_PATTERN.test((parsed as DeviceIdentityFile).deviceId)
  ) {
    throw new Error(`Agentlet device identity is invalid at ${path}`)
  }
  return (parsed as DeviceIdentityFile).deviceId
}

export function resolveDeviceIdentity(
  path = defaultDeviceIdentityPath(),
): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) return parseDeviceIdentity(path)

  const deviceId = randomUUID()
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(
      descriptor,
      `${JSON.stringify({ version: 1, deviceId } satisfies DeviceIdentityFile)}\n`,
      'utf8',
    )
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporaryPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return parseDeviceIdentity(path)
}
