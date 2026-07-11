import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildForkTargetSpec } from './fork.js';
import { setWorkspacePath } from '../../workspace.js';

import type { AcpWorkloadSpec, BuiltinWorkloadSpec } from './drivers.js';

const workspace = mkdtempSync(join(tmpdir(), 'sediment-fork-test-'));

beforeAll(() => {
  setWorkspacePath(workspace);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('buildForkTargetSpec', () => {
  it('retargets a built-in spec and removes legacy initial messages', () => {
    const source: BuiltinWorkloadSpec = {
      threadId: 'source',
      kind: 'internal',
      workloadType: 'Deployment',
      namespace: { name: 'source_canvas' },
      spec: {
        recipe: { model: { type: 'host', id: 'active' } },
        initialMessages: [
          { role: 'user', content: 'legacy seed', timestamp: 1 },
        ],
        hostContext: { canvasId: 'source_canvas', retained: true },
      },
    };

    expect(buildForkTargetSpec(source, 'target', 'target_canvas')).toEqual({
      ...source,
      threadId: 'target',
      namespace: expect.objectContaining({ name: 'target_canvas' }),
      spec: {
        ...source.spec,
        initialMessages: [],
        hostContext: { canvasId: 'target_canvas', retained: true },
      },
    });
  });

  it('retargets an ACP spec and rebuilds host-owned reachback env', () => {
    const source: AcpWorkloadSpec = {
      threadId: 'source',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: { name: 'source_canvas' },
      binding: { alias: 'copilot', profileId: 'profile_1' },
      recipe: {
        alias: 'copilot',
        command: 'copilot --acp',
        cwd: '/repo',
        autoRestart: false,
      },
      env: { HUABU_THREAD_ID: 'source' },
    };

    const target = buildForkTargetSpec(source, 'target', 'target_canvas');
    expect(target).toMatchObject({
      threadId: 'target',
      namespace: { name: 'target_canvas' },
      env: { HUABU_THREAD_ID: 'target' },
    });
  });
});
