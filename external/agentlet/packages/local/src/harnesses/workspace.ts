import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KNOWN_CLIS } from './catalogue.js'

/** Only static catalogue IDs may select daemon-owned workspaces. Existing contents are retained. */
export async function prepareHarnessWorkspace(id: string): Promise<string> {
  const harness = KNOWN_CLIS.find((entry) => entry.id === id)
  if (!harness) throw new Error(`Unknown harness ID: ${id}`)
  const workingDirPath = join(homedir(), '.agentlet', 'workspace', harness.id)
  await mkdir(workingDirPath, { recursive: true })
  return workingDirPath
}
