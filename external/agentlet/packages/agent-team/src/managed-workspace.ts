import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const MARKER_SCHEMA = 'agentlet-managed-setup-v1';
const MARKER_FILENAME = '.agentlet-setup.json';

interface ManagedSetupMarker {
  schema: typeof MARKER_SCHEMA;
  harness: string;
}

export function clearManagedSetupMarker(workingDirPath: string): void {
  rmSync(join(workingDirPath, MARKER_FILENAME), { force: true });
}

export function markManagedSetupReady(
  workingDirPath: string,
  harness: string,
): void {
  const markerPath = join(workingDirPath, MARKER_FILENAME);
  const temporaryPath = `${markerPath}.tmp`;
  const marker: ManagedSetupMarker = { schema: MARKER_SCHEMA, harness };
  writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, 'utf8');
  renameSync(temporaryPath, markerPath);
}

export function isManagedSetupReady(
  workingDirPath: string,
  harness: string,
): boolean {
  try {
    const marker = JSON.parse(
      readFileSync(join(workingDirPath, MARKER_FILENAME), 'utf8'),
    ) as Partial<ManagedSetupMarker>;
    return marker.schema === MARKER_SCHEMA && marker.harness === harness;
  } catch {
    return false;
  }
}
