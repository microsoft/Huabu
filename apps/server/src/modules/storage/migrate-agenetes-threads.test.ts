import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileThreadStore } from '@agenetes/agenetes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  migrateAgenetesThreadFile,
  migrateLegacyAgenetesThreads,
  repairExternalAgentPreambles,
} from './migrate-agenetes-threads.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-migrate-agenetes-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeLegacy(
  records: Record<string, unknown>,
  canvas = 'Canvas',
): string {
  const history = join(tmp, canvas, '.history');
  mkdirSync(history, { recursive: true });
  const filePath = join(history, 'threads.json');
  writeFileSync(
    filePath,
    JSON.stringify({ schemaVersion: 'agenetes-v1', records }),
  );
  return filePath;
}

const namespace = {
  name: 'canvas-1',
  storage: { root: '' },
};

describe('migrateLegacyAgenetesThreads', () => {
  it('migrates pi and ACP records into driver-owned v2 specs and state', () => {
    const filePath = writeLegacy({
      internal: {
        spec: {
          kind: 'internal',
          workloadType: 'Deployment',
          namespace: {
            ...namespace,
            storage: { root: join(tmp, 'Canvas', '.history') },
          },
          threadId: 'internal',
          initialPreamble: ['Operate safely.'],
          spec: {
            recipe: {
              model: { type: 'host', id: 'active' },
            },
          },
        },
        state: { metadata: { currentModelId: 'model-1' } },
      },
      external: {
        spec: {
          kind: 'external',
          workloadType: 'Deployment',
          namespace: {
            ...namespace,
            storage: { root: join(tmp, 'Canvas', '.history') },
          },
          threadId: 'external',
          initialPreamble: ['Use the canvas tools.'],
          binding: { alias: 'Copilot', profileId: 'copilot' },
          profile: {
            profileId: 'copilot',
            agentletId: 'local',
            workingDirPath: '/project',
            launch: { kind: 'acp-command', command: 'copilot --acp' },
          },
          env: { REACHBACK: '1' },
        },
        state: {
          sessionId: 'session-1',
          metadata: { currentModeId: 'agent' },
        },
      },
    });

    expect(migrateLegacyAgenetesThreads(tmp)).toBe(2);
    expect(existsSync(`${filePath}.agenetes-v1.bak`)).toBe(true);

    const store = new FileThreadStore();
    const scope = {
      name: 'canvas-1',
      storage: { root: join(tmp, 'Canvas', '.history') },
    };
    const internal = store.get(scope, 'internal');
    expect(internal?.driverSchemaVersion).toBe(1);
    expect(internal?.spec.spec).toMatchObject({
      initialPreamble: ['Operate safely.'],
      recipe: { model: { type: 'host', id: 'active' } },
    });
    expect(internal?.state).toMatchObject({
      driverState: {},
      metadata: { currentModelId: 'model-1' },
    });

    const external = store.get(scope, 'external');
    expect(external?.spec.spec).toMatchObject({
      initialPreamble: ['Use the canvas tools.'],
      agentletId: 'local',
      cwd: '/project',
      recipe: { command: 'copilot --acp', autoRestart: true },
    });
    expect(external?.state.driverState).toEqual({
      sessionId: 'session-1',
      initialPreambleDelivered: false,
    });
  });

  it('is a no-op for v2 and rejects unknown v1 kinds without touching data', () => {
    const v2Path = writeLegacy({}, 'Current');
    writeFileSync(
      v2Path,
      JSON.stringify({ schemaVersion: 'agenetes-v2', records: {} }),
    );
    expect(migrateAgenetesThreadFile(v2Path)).toBe(0);

    const invalidPath = writeLegacy({
      thread: {
        spec: {
          kind: 'unknown',
          workloadType: 'Deployment',
          namespace,
          threadId: 'thread',
          spec: {},
        },
        state: {},
      },
    });
    const before = readFileSync(invalidPath, 'utf-8');
    expect(() => migrateAgenetesThreadFile(invalidPath)).toThrow(
      "uses unknown kind 'unknown'",
    );
    expect(readFileSync(invalidPath, 'utf-8')).toBe(before);
    expect(existsSync(`${invalidPath}.agenetes-v1.bak`)).toBe(false);
  });

  it('migrates the legacy flattened pi Job shape', () => {
    const filePath = writeLegacy({
      'legacy-pi': {
        spec: {
          kind: 'internal',
          workloadType: 'Job',
          namespace: {
            name: 'canvas-1',
            storage: { root: join(tmp, 'Canvas', '.history') },
          },
          threadId: 'legacy-pi',
          systemPrompt: 'Operate safely.',
          scope: 'operate',
          canvasId: 'canvas-1',
          messages: [{ role: 'user', content: 'Inspect the selected node.' }],
          maxIterations: 20,
        },
        state: {},
      },
    });

    expect(migrateAgenetesThreadFile(filePath)).toBe(1);

    const store = new FileThreadStore();
    const migrated = store.get(
      {
        name: 'canvas-1',
        storage: { root: join(tmp, 'Canvas', '.history') },
      },
      'legacy-pi',
    );
    expect(migrated?.spec.spec).toEqual({
      initialPreamble: ['Operate safely.'],
      recipe: {
        model: { type: 'host', id: 'active' },
        runtime: { maxIterations: 20, toolExecution: 'parallel' },
      },
      initialMessages: [
        { role: 'user', content: 'Inspect the selected node.' },
      ],
      hostContext: { canvasId: 'canvas-1', legacyScope: 'operate' },
    });
  });

  it('repairs an undelivered external Deployment missing its preamble', () => {
    const history = join(tmp, 'Canvas', '.history');
    mkdirSync(history, { recursive: true });
    const scope = {
      name: 'canvas-1',
      storage: { root: history },
    };
    const store = new FileThreadStore();
    store.upsert(scope, 'external', {
      driverSchemaVersion: 1,
      spec: {
        kind: 'external',
        workloadType: 'Deployment',
        namespace: scope,
        threadId: 'external',
        spec: {
          binding: { alias: 'Copilot', profileId: 'copilot' },
        },
      },
      state: {
        driverState: { initialPreambleDelivered: false },
      },
    });

    expect(repairExternalAgentPreambles(tmp, 'Use Huabu RFS.')).toBe(1);
    expect(repairExternalAgentPreambles(tmp, 'Use Huabu RFS.')).toBe(0);
    expect(store.get(scope, 'external')).toMatchObject({
      spec: { spec: { initialPreamble: ['Use Huabu RFS.'] } },
      state: { driverState: { initialPreambleDelivered: false } },
    });
  });
});
