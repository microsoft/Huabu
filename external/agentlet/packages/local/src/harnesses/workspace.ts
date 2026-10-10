import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getHarnessDefinition } from './registry.js'

/** Only static catalogue IDs may select daemon-owned workspaces. Existing contents are retained. */
export async function prepareHarnessWorkspace(id: string): Promise<string> {
  const harness = getHarnessDefinition(id)
  if (harness.id === 'custom') throw new Error('Custom harness has no daemon-owned workspace')
  const workingDirPath = join(homedir(), '.agentlet', 'workspace', harness.id)
  await mkdir(workingDirPath, { recursive: true })
  return workingDirPath
}
