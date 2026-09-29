// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ThreadRecord } from '@agenetes/agenetes';
const complete = vi.hoisted(() => vi.fn());
const runText = vi.hoisted(() => vi.fn());
vi.mock('./llm.js', () => ({ llmComplete: complete }));
vi.mock('./functional-text.js', () => ({ runFunctionalText: runText }));

let tmp: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
  complete.mockReset();
  runText.mockReset();
});

describe('conversation naming through canonical ProviderManager routing', () => {
  it('retains the accepted title on external failure, then retries through the external text path', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'huabu-title-provider-'));
    vi.stubEnv('HUABU_DATA_DIR', tmp);
    vi.resetModules();
    const { ProviderManager } =
      await import('../preprocessing/provider-manager.js');
    const { ConversationTitleService } =
      await import('./conversation-title.service.js');
    const provider = new ProviderManager();
    let record: ThreadRecord = {
      driverSchemaVersion: 1,
      spec: {
        kind: 'test',
        workloadType: 'Deployment',
        threadId: 'thread-a',
        namespace: { name: 'canvas-a' },
        spec: {},
      },
      state: {
        driverState: {},
        metadata: { sessionInfo: { title: 'ACP fallback', updatedAt: null } },
      },
    };
    const generate = vi.fn(
      async (prompt: string, canvasId: string) =>
        (
          await provider.generateContentMeta(
            prompt,
            {
              needLabel: true,
              needSummary: false,
              needKeywords: false,
            },
            { canvasId },
          )
        )?.label,
    );
    const onError = vi.fn();
    const service = new ConversationTitleService({
      readRecord: () => record,
      updateHostMetadata: (_canvas, _thread, patch) => {
        record = {
          ...record,
          hostMetadata: { ...record.hostMetadata, ...patch },
        };
      },
      firstPrompt: () => 'Original first prompt',
      generate,
      notifications: async function* () {},
      onError,
    });
    runText.mockRejectedValueOnce(
      new Error('Select a default external Agent Profile in Settings'),
    );
    await service.initialize('canvas-a', 'thread-a', 'Later prompt');
    expect(onError).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'ACP fallback',
      source: 'acp',
    });

    runText.mockResolvedValue('{"label":"External title"}');
    await service.initialize('canvas-a', 'thread-a', 'Another later prompt');
    expect(runText).toHaveBeenCalledTimes(2);
    expect(runText.mock.calls[1][0]).toContain('Original first prompt');
    expect(runText.mock.calls[1][0]).not.toContain('Another later prompt');
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'External title',
      source: 'generated',
    });
    expect(record.state.metadata?.sessionInfo?.title).toBe('ACP fallback');

    expect(runText.mock.calls[1][1]).toEqual({ canvasId: 'canvas-a' });
    expect(complete).not.toHaveBeenCalled();
  });
});
