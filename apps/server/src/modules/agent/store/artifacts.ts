import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createId } from '@sediment/shared';

function getArtifactsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at: apps/server/src/modules/agent/store/*.ts
  // We want: apps/server/data/artifacts
  return path.resolve(here, '../../../../data/artifacts');
}

export async function saveTextArtifact(
  text: string,
  meta?: Record<string, unknown>,
): Promise<{ ref: string; id: string }> {
  const artifactsDir = getArtifactsDir();
  await mkdir(artifactsDir, { recursive: true });

  const id = createId('artifact');
  const filePath = path.join(artifactsDir, `${id}.json`);
  const payload = {
    id,
    createdAt: new Date().toISOString(),
    meta: meta ?? {},
    text,
  };

  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { id, ref: `artifact://${id}` };
}
