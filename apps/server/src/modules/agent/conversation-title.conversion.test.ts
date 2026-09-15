// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agenetes, EXTERNAL_DRIVER_KIND } from './agenetes/drivers.js';
import {
  CONVERSATION_TITLE_METADATA_KEY,
  ConversationTitleService,
} from './conversation-title.service.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { PreprocessDispatcher } from '../preprocessing/dispatcher.js';
import { ProviderManager } from '../preprocessing/provider-manager.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { ThreadRecord } from '@agenetes/agenetes';
import type { ConversationTitle } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const canvasId = 'canvas-conversion';
const threadId = 'thread-conversion';
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-title-conversion-'));
  vi.stubEnv('HUABU_DATA_DIR', tmp);
  setWorkspacePath(tmp);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

async function fixture(
  source: NonNullable<ConversationTitle['source']> = 'acp',
  convertImmediately = true,
) {
  const title = {
    acp: 'ACP fallback',
    generated: 'Generated title',
    fallback: 'First user prompt',
    user: 'Manual title',
  }[source];
  const labelSource = source === 'user' ? 'user' : 'agent';
  let record: ThreadRecord = {
    driverSchemaVersion: 1,
    spec: {
      kind: EXTERNAL_DRIVER_KIND,
      workloadType: 'Deployment',
      threadId,
      namespace: { name: canvasId },
      spec: {
        binding: {
          kind: 'external',
          profileId: 'profile-conversion',
          alias: 'Conversion Agent',
        },
      },
    },
    state: {
      driverState: {},
      metadata: {
        sessionInfo: { title: source === 'acp' ? title : '', updatedAt: null },
      },
    },
    hostMetadata: {
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title,
        source,
      },
    },
  };
  vi.spyOn(agenetes, 'record').mockImplementation(() => record);
  vi.spyOn(agenetes, 'history').mockReturnValue({ turns: [] } as never);
  vi.spyOn(agenetes, 'updateHostMetadata').mockImplementation(
    (_namespace, _thread, patch) => {
      record = JSON.parse(
        JSON.stringify({
          ...record,
          hostMetadata: { ...record.hostMetadata, ...patch },
        }),
      ) as ThreadRecord;
      return record;
    },
  );
  const generate = vi
    .spyOn(ProviderManager.prototype, 'generateContentMeta')
    .mockResolvedValue({ label: 'Generated title' });
  const notifications = vi
    .spyOn(agenetes, 'notifications')
    .mockImplementation(async function* () {});
  const notify = async (service: ConversationTitleService, title: string) => {
    let finished = false;
    notifications.mockImplementationOnce(async function* () {
      record.state.metadata = {
        sessionInfo: { title, updatedAt: null },
      };
      yield record.state.metadata;
      finished = true;
    });
    service.subscribe(canvasId, threadId);
    await vi.waitFor(() => expect(finished).toBe(true));
  };
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await executeOnServer({
    canvasId,
    originator: { source: 'ui' },
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-existing-title',
            nodeType: 'note',
            position: { x: 0, y: 0 },
            data: { label: title },
          },
        ],
      },
    ],
  });
  const convert = async () => {
    await executeOnServer({
      canvasId,
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-q',
              nodeType: 'question',
              position: { x: 200, y: 0 },
              data: {
                threadId,
                label: title,
                labelSource,
                content: 'First user prompt',
              },
            },
          ],
        },
      ],
    });
    const node = store.readNode('node-q');
    const canvas = store.read();
    expect(node).toMatchObject({
      label: `${title} 1`,
      labelSource,
      content: 'First user prompt',
    });
    expect(canvas?.state.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'node-q',
          data: expect.objectContaining({
            threadId,
            bindingState: 'bound',
            agentBinding: {
              kind: 'external',
              profileId: 'profile-conversion',
              alias: 'Conversion Agent',
            },
          }),
        }),
      ]),
    );
    const question = (canvas?.state.nodes as CanvasNode[] | undefined)?.find(
      (entry) => entry.id === 'node-q',
    );
    expect(question?.data).not.toHaveProperty('status');
    expect(question?.data).not.toHaveProperty('viewed');
    expect(question?.data).not.toHaveProperty('invocationToken');
    return () => {
      const reopened = getCanvasStore(canvasId);
      expect(reopened.readNode('node-q')).toEqual(node);
      expect(reopened.read()?.version).toBe(canvas?.version);
      expect(reopened.read()).toEqual(canvas);
    };
  };
  const checkUnchanged = convertImmediately ? await convert() : undefined;
  const assertUnchanged = () => {
    if (!checkUnchanged)
      throw new Error('Question conversion has not been created');
    checkUnchanged();
  };
  return {
    store,
    generate,
    record: () => record,
    convert,
    assertUnchanged,
    notify,
  };
}

describe('persisted Chat to Question title conversion', () => {
  it('keeps the canonical copied ACP label through retries, ACP metadata, generated and manual Chat titles, and restart', async () => {
    const { generate, record, assertUnchanged, notify } = await fixture();
    generate.mockResolvedValueOnce(undefined);
    const service = new ConversationTitleService();
    await service.initialize(canvasId, threadId, 'First user prompt');
    assertUnchanged();
    expect(record().hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY]).toEqual({
      title: 'ACP fallback',
      source: 'acp',
    });
    await notify(service, 'Later ACP title');
    expect(service.get(canvasId, threadId)).toEqual({
      title: 'Later ACP title',
      source: 'acp',
    });
    assertUnchanged();
    const restarted = new ConversationTitleService();
    await Promise.all([
      restarted.initialize(canvasId, threadId, 'First user prompt'),
      restarted.initialize(canvasId, threadId, 'First user prompt'),
    ]);
    expect(record().hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY]).toEqual({
      title: 'Generated title',
      source: 'generated',
    });
    assertUnchanged();
    await notify(restarted, 'Late ACP');
    expect(restarted.get(canvasId, threadId)).toEqual({
      title: 'Generated title',
      source: 'generated',
    });
    assertUnchanged();
    expect(restarted.setUserTitle(canvasId, threadId, 'Renamed Chat')).toEqual({
      title: 'Renamed Chat',
      source: 'user',
    });
    assertUnchanged();
    const again = new ConversationTitleService();
    await again.initialize(canvasId, threadId, 'Later prompt');
    expect(again.get(canvasId, threadId)).toEqual({
      title: 'Renamed Chat',
      source: 'user',
    });
    assertUnchanged();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith('First user prompt', {
      needLabel: true,
      needSummary: false,
      needKeywords: false,
    });
  });

  it.each(['generated', 'fallback', 'user'] as const)(
    'preserves the canonical copied %s label through later Chat titles and restart',
    async (source) => {
      const { generate, assertUnchanged, notify } = await fixture(source);
      const service = new ConversationTitleService();
      await service.initialize(canvasId, threadId, 'First user prompt');
      generate.mockResolvedValue({ label: 'Later generated title' });
      await service.initialize(canvasId, threadId, 'Later prompt');
      expect(service.get(canvasId, threadId)).toEqual({
        title: source === 'user' ? 'Manual title' : 'Generated title',
        source: source === 'user' ? 'user' : 'generated',
      });
      assertUnchanged();
      await notify(service, 'Later ACP title');
      assertUnchanged();
      service.setUserTitle(canvasId, threadId, 'Later manual Chat title');
      assertUnchanged();
      const restarted = new ConversationTitleService();
      await restarted.initialize(canvasId, threadId, 'Later prompt');
      expect(restarted.get(canvasId, threadId)).toEqual({
        title: 'Later manual Chat title',
        source: 'user',
      });
      assertUnchanged();
      expect(generate).toHaveBeenCalledTimes(source === 'fallback' ? 1 : 0);
    },
  );

  it('does not rename the created Question when pre-conversion generation finishes', async () => {
    const { store, generate, convert } = await fixture('acp', false);
    let complete!: (value: { label: string }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    generate.mockImplementationOnce(() => {
      markStarted();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const service = new ConversationTitleService();
    const pending = service.initialize(canvasId, threadId, 'First user prompt');
    await started;
    expect(store.readNode('node-q')).toBeNull();
    const assertUnchanged = await convert();
    complete({ label: 'Generated title' });
    await pending;
    expect(service.get(canvasId, threadId)).toEqual({
      title: 'Generated title',
      source: 'generated',
    });
    assertUnchanged();
    await new ConversationTitleService().initialize(
      canvasId,
      threadId,
      'Later prompt',
    );
    assertUnchanged();
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(['acp', 'generated', 'fallback', 'user'] as const)(
    'protects a copied %s title during ordinary Question preprocessing',
    async (source) => {
      const { store, generate, assertUnchanged } = await fixture(source);
      const node = store.readNode('node-q');
      if (!node) throw new Error('Missing converted Question node');
      const result = await new PreprocessDispatcher().preprocess({
        canvasId,
        nodeId: 'node-q',
        nodeType: 'question',
        trigger: 'node_inserted',
        snapshot: {
          content: node.content,
          title: node.label,
          labelSource: node.labelSource,
        },
      });
      expect(result.success).toBe(true);
      expect(result.usedCapabilities).not.toContain('generate_label');
      expect(result.patch).not.toHaveProperty('label');
      expect(result.patch).not.toHaveProperty('labelSource');
      expect(generate).not.toHaveBeenCalled();
      assertUnchanged();
    },
  );
});
