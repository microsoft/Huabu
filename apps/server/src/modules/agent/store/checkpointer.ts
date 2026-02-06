import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

let saverPromise: Promise<SqliteSaver> | null = null;

function getCheckpointDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at: apps/server/src/modules/agent/store/*.ts
  // We want: apps/server/data
  const dataDir = path.resolve(here, '../../../../data');
  return path.join(dataDir, 'langgraph-checkpoints.sqlite');
}

export async function getCheckpointer(): Promise<SqliteSaver> {
  if (saverPromise) return saverPromise;

  saverPromise = (async () => {
    const checkpointDbPath = getCheckpointDbPath();
    await mkdir(path.dirname(checkpointDbPath), { recursive: true });

    // Use a file-based SQLite DB for local/demo workflows.
    // `fromConnString` accepts either a connection string or a local path.
    return SqliteSaver.fromConnString(checkpointDbPath);
  })();

  return saverPromise;
}
