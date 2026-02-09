import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createId } from '@sediment/shared';

import { getArtifactsDir } from '../../artifact/utils.js';

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
