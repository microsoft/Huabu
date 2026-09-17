// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_TITLE_METADATA_KEY,
  ConversationTitleService,
  effectiveConversationTitle,
} from './conversation-title.service.js';

import type { ConversationTitleDependencies } from './conversation-title.service.js';
import type { ThreadRecord } from '@agenetes/agenetes';

function fixture() {
  const records = new Map<string, ThreadRecord>([
    [
      'canvas-a/thread-a',
      {
        driverSchemaVersion: 1,
        spec: {
          kind: 'test',
          workloadType: 'Deployment',
          threadId: 'thread-a',
          namespace: { name: 'canvas-a' },
          spec: {},
        },
        state: { driverState: {} },
      },
    ],
  ]);
  const getRecord = (canvas = 'canvas-a', thread = 'thread-a') => {
    const record = records.get(`${canvas}/${thread}`);
    if (!record) throw new Error(`Missing thread record: ${canvas}/${thread}`);
    return record;
  };
  const deps: ConversationTitleDependencies = {
    readRecord: (canvas, thread) => records.get(`${canvas}/${thread}`),
    updateHostMetadata: vi.fn((canvas, thread, patch) => {
      const record = getRecord(canvas, thread);
      records.set(`${canvas}/${thread}`, {
        ...record,
        hostMetadata: { ...record.hostMetadata, ...patch },
      });
    }),
    firstPrompt: vi.fn(() => 'Original first prompt'),
    generate: vi.fn(async () => 'Semantic title'),
    notifications: vi.fn(async function* () {}),
    onError: vi.fn(),
  };
  const service = new ConversationTitleService(deps);
  const metadata = (title: string | null) => {
    records.set('canvas-a/thread-a', {
      ...getRecord(),
      state: {
        driverState: {},
        metadata: { sessionInfo: { title, updatedAt: null } },
      },
    });
  };
  const notify = async (
    title: string | null,
    target = service,
    canvas = 'canvas-a',
    thread = 'thread-a',
  ) => {
    let finished = false;
    vi.mocked(deps.notifications).mockImplementationOnce(async function* () {
      yield { sessionInfo: { title, updatedAt: null } };
      finished = true;
    });
    target.subscribe(canvas, thread);
    await vi.waitFor(() => expect(finished).toBe(true));
  };
  return { service, deps, records, getRecord, metadata, notify };
}

describe('generated-first conversation titles', () => {
  it('normalizes titles with the shared host and ACP policies', async () => {
    const { service, deps, getRecord, notify } = fixture();
    await notify('  ACP\t title  ');
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: { title: 'ACP title', source: 'acp' },
    });
    await notify('Injected\nprompt');
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: { title: 'ACP title', source: 'acp' },
    });
    vi.mocked(deps.generate).mockResolvedValueOnce(`  ${'x'.repeat(121)}  `);
    await service.initialize('canvas-a', 'thread-a', 'Prompt');
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'x'.repeat(120),
        source: 'generated',
      },
    });
    await service.setUserTitle('canvas-a', 'thread-a', '  Manual\n\t title  ');
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'Manual title',
        source: 'user',
      },
    });
    await expect(
      service.setUserTitle('canvas-a', 'thread-a', ' \n '),
    ).rejects.toThrow('Invalid conversation title');
  });

  it.each([undefined, null, '', ' \n ', 42])(
    'ignores unusable generated title %j',
    async (value) => {
      const { service, deps, getRecord, metadata } = fixture();
      metadata('Retained ACP');
      // Exercise malformed runtime provider output as well as typed absence.
      vi.mocked(deps.generate).mockImplementationOnce(
        vi.fn().mockResolvedValue(value),
      );
      await service.initialize('canvas-a', 'thread-a', 'Prompt');
      expect(deps.generate).toHaveBeenCalledExactlyOnceWith(
        'Original first prompt',
      );
      expect(
        (await service.query('canvas-a', ['thread-a'])).titles['thread-a'],
      ).toEqual({
        title: 'Retained ACP',
        source: 'acp',
      });
      expect(getRecord().hostMetadata).toBeUndefined();
      expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    },
  );

  it('derives first-prompt fallback on query without persisting or generating', async () => {
    const { service, deps, getRecord } = fixture();
    vi.mocked(deps.firstPrompt).mockReturnValue('Intro\n# **First** heading');
    const before = JSON.stringify(getRecord());
    expect(await service.query('canvas-a', ['thread-a'])).toEqual({
      titles: { 'thread-a': { title: 'First heading', source: 'fallback' } },
    });
    vi.mocked(deps.firstPrompt).mockReturnValue(undefined);
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: null,
      source: null,
    });
    expect(JSON.stringify(getRecord())).toBe(before);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
  });

  it('uses the submission before history exists and retries failed generation later', async () => {
    const { service, deps, getRecord } = fixture();
    vi.mocked(deps.firstPrompt).mockReturnValue(undefined);
    vi.mocked(deps.generate).mockResolvedValueOnce(undefined);
    await service.initialize('canvas-a', 'thread-a', '# **First** submission');
    expect(deps.generate).toHaveBeenCalledExactlyOnceWith(
      '# **First** submission',
    );
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'First submission',
        source: 'fallback',
      },
    });
    vi.mocked(deps.firstPrompt).mockReturnValue('# **First** submission');
    await new ConversationTitleService(deps).initialize(
      'canvas-a',
      'thread-a',
      'Later turn',
    );
    expect(deps.generate).toHaveBeenCalledTimes(2);
    expect(deps.generate).toHaveBeenLastCalledWith('# **First** submission');
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'Semantic title',
        source: 'generated',
      },
    });
  });

  it('does not generate from an empty prompt', async () => {
    const { service, deps, getRecord } = fixture();
    vi.mocked(deps.firstPrompt).mockReturnValue(undefined);
    await service.initialize('canvas-a', 'thread-a', ' \n ');
    expect(deps.generate).not.toHaveBeenCalled();
    expect(getRecord().hostMetadata).toBeUndefined();
  });

  it('persists only the current title and source, rejecting lower-priority writes', async () => {
    const { service, deps, getRecord, metadata, notify } = fixture();
    vi.mocked(deps.generate).mockResolvedValueOnce(undefined);
    await service.initialize('canvas-a', 'thread-a', 'Prompt');
    expect(getRecord().hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY]).toEqual(
      {
        title: 'Original first prompt',
        source: 'fallback',
      },
    );
    await notify('ACP');
    expect(getRecord().hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY]).toEqual(
      {
        title: 'ACP',
        source: 'acp',
      },
    );
    let complete!: (title: string) => void;
    vi.mocked(deps.generate).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const competing = new ConversationTitleService(deps).initialize(
      'canvas-a',
      'thread-a',
      'Competing request',
    );
    await vi.waitFor(() => expect(deps.generate).toHaveBeenCalledTimes(2));
    vi.mocked(deps.generate).mockResolvedValueOnce('Generated');
    await service.initialize('canvas-a', 'thread-a', 'Prompt');
    vi.mocked(deps.updateHostMetadata).mockClear();
    metadata('Late ACP');
    await notify('Late ACP');
    complete('Second generation');
    await competing;
    expect(getRecord().hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY]).toEqual(
      {
        title: 'Generated',
        source: 'generated',
      },
    );
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    await service.setUserTitle('canvas-a', 'thread-a', 'Manual');
    vi.mocked(deps.updateHostMetadata).mockClear();
    await service.initialize('canvas-a', 'thread-a', 'Rejected');
    await notify('Rejected ACP');
    expect(deps.generate).toHaveBeenCalledTimes(3);
    expect(getRecord().hostMetadata?.[CONVERSATION_TITLE_METADATA_KEY]).toEqual(
      {
        title: 'Manual',
        source: 'user',
      },
    );
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    expect(
      await new ConversationTitleService(deps).get('canvas-a', 'thread-a'),
    ).toEqual({ title: 'Manual', source: 'user' });
    await service.setUserTitle('canvas-a', 'thread-a', 'Second manual');
    expect((await service.get('canvas-a', 'thread-a')).title).toBe(
      'Second manual',
    );
  });

  it('rejects late generation and ACP after a manual rename without retaining candidates', async () => {
    const { service, deps, getRecord, notify } = fixture();
    let complete!: (title: string) => void;
    vi.mocked(deps.generate).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const running = service.initialize('canvas-a', 'thread-a', 'Prompt');
    await vi.waitFor(() => expect(deps.generate).toHaveBeenCalledOnce());
    await notify('ACP name');
    await service.setUserTitle('canvas-a', 'thread-a', 'Manual panel');
    vi.mocked(deps.updateHostMetadata).mockClear();
    complete('Late generated');
    await running;
    await notify('Late ACP');
    await new ConversationTitleService(deps).initialize(
      'canvas-a',
      'thread-a',
      'Retry',
    );
    expect(deps.generate).toHaveBeenCalledOnce();
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'Manual panel',
        source: 'user',
      },
    });
  });

  it('orders manual > generated > current ACP > saved ACP > fallback without driver metadata writes', async () => {
    const { service, deps, metadata, getRecord, notify } = fixture();
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'Original first prompt',
      source: 'fallback',
    });
    await notify('Saved ACP');
    metadata('Current ACP');
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'Current ACP',
      source: 'acp',
    });
    metadata('');
    expect((await service.get('canvas-a', 'thread-a')).title).toBe('Saved ACP');
    await service.initialize('canvas-a', 'thread-a', 'Later prompt');
    expect(deps.generate).toHaveBeenCalledExactlyOnceWith(
      'Original first prompt',
    );
    metadata('Late ACP');
    await notify('Late ACP');
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'Semantic title',
      source: 'generated',
    });
    expect(
      await service.setUserTitle('canvas-a', 'thread-a', ' My name '),
    ).toEqual({
      title: 'My name',
      source: 'user',
    });
    expect(getRecord().state.metadata?.sessionInfo?.title).toBe('Late ACP');
    await new ConversationTitleService(deps).initialize(
      'canvas-a',
      'thread-a',
      'Retry',
    );
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['undefined', 'failure'])(
    'keeps ACP after %s and retries once on a future initialize',
    async (outcome) => {
      const { service, deps, metadata, records, getRecord } = fixture();
      metadata('ACP fallback');
      records.set('canvas-a/thread-a', {
        ...getRecord(),
        hostMetadata: {
          otherFeature: { enabled: true },
          [CONVERSATION_TITLE_METADATA_KEY]: {
            title: 'ACP fallback',
            source: 'acp',
          },
        },
      });
      vi.mocked(deps.generate).mockImplementationOnce(async () => {
        if (outcome === 'failure') throw new Error('provider unavailable');
        return undefined;
      });
      await Promise.all([
        service.initialize('canvas-a', 'thread-a', 'Later request'),
        service.initialize('canvas-a', 'thread-a', 'Concurrent request'),
      ]);
      expect(deps.generate).toHaveBeenCalledTimes(1);
      expect(await service.get('canvas-a', 'thread-a')).toEqual({
        title: 'ACP fallback',
        source: 'acp',
      });
      expect(deps.onError).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
      const restarted = new ConversationTitleService(deps);
      await restarted.initialize(
        'canvas-a',
        'thread-a',
        'Configured model now',
      );
      expect(deps.generate).toHaveBeenCalledTimes(2);
      expect(deps.generate).toHaveBeenLastCalledWith('Original first prompt');
      expect((await restarted.get('canvas-a', 'thread-a')).source).toBe(
        'generated',
      );
      expect(getRecord().hostMetadata).toEqual({
        otherFeature: { enabled: true },
        [CONVERSATION_TITLE_METADATA_KEY]: {
          title: 'Semantic title',
          source: 'generated',
        },
      });
      expect(getRecord().state.metadata?.sessionInfo?.title).toBe(
        'ACP fallback',
      );
    },
  );

  it('accepts prompt-like ACP text and never mutates or pays for query reads', async () => {
    const { service, deps, metadata, getRecord, notify } = fixture();
    const title =
      'You are a helpful assistant collaborating with a user inside **Huabu**';
    metadata(title);
    const before = JSON.stringify(getRecord());
    expect(
      (await service.query('canvas-a', ['thread-a'])).titles['thread-a'],
    ).toEqual({
      title,
      source: 'acp',
    });
    expect(JSON.stringify(getRecord())).toBe(before);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    await notify(title);
    metadata('x'.repeat(121));
    await notify('x'.repeat(121));
    expect((await service.get('canvas-a', 'thread-a')).title).toBe(title);
  });

  it.each([null, '', '  ', 'x'.repeat(121)])(
    'ignores invalid raw/saved ACP %j without recovery',
    async (invalid) => {
      const { service, deps, metadata, records, getRecord, notify } = fixture();
      metadata(invalid);
      records.set('canvas-a/thread-a', {
        ...getRecord(),
        hostMetadata: {
          [CONVERSATION_TITLE_METADATA_KEY]: { title: invalid, source: 'acp' },
        },
      });
      const before = JSON.stringify(getRecord());
      expect((await service.get('canvas-a', 'thread-a')).source).toBe(
        'fallback',
      );
      await notify(invalid);
      expect(JSON.stringify(getRecord())).toBe(before);
      expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    },
  );

  it('coalesces initialization and upgrades ACP with late generation', async () => {
    const { service, deps, metadata, getRecord, notify } = fixture();
    let complete!: (title: string) => void;
    deps.generate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const running = service.initialize('canvas-a', 'thread-a', 'Prompt');
    const concurrent = service.initialize('canvas-a', 'thread-a', 'Later');
    expect(concurrent).toBe(running);
    await vi.waitFor(() => expect(deps.generate).toHaveBeenCalledOnce());
    metadata('ACP arrived');
    await notify('ACP arrived');
    complete('Slow generated');
    await Promise.all([running, concurrent]);
    await notify('Late ACP');
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'Slow generated',
      source: 'generated',
    });
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'Slow generated',
        source: 'generated',
      },
    });
    expect(deps.generate).toHaveBeenCalledExactlyOnceWith(
      'Original first prompt',
    );
  });

  it('skips duplicate persisted ACP writes across restart and accepts changed titles', async () => {
    const { deps, metadata, getRecord, notify } = fixture();
    metadata('First ACP');
    await notify('First ACP');
    vi.mocked(deps.updateHostMetadata).mockClear();
    const restarted = new ConversationTitleService(deps);
    await notify('First ACP', restarted);
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    metadata('Changed ACP');
    await notify('Changed ACP', restarted);
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: {
        title: 'Changed ACP',
        source: 'acp',
      },
    });
    expect(deps.updateHostMetadata).toHaveBeenCalledOnce();
  });

  it('validates manual names and does not create or rename absent/cross-canvas threads', async () => {
    const { service, deps, notify } = fixture();
    await expect(
      service.setUserTitle('canvas-a', 'thread-a', 'x'.repeat(121)),
    ).rejects.toThrow('Invalid conversation title');
    expect(await service.query('canvas-b', ['thread-a', '__proto__'])).toEqual({
      titles: {
        'thread-a': { title: null, source: null },
        ['__proto__']: { title: null, source: null },
      },
    });
    expect(
      await service.setUserTitle('canvas-b', 'thread-a', 'Name'),
    ).toBeNull();
    await service.initialize('canvas-a', 'missing', 'Prompt');
    await service.initialize('canvas-b', 'thread-a', 'Generated');
    await notify('ACP', service, 'canvas-b');
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.firstPrompt).not.toHaveBeenCalled();
    expect(deps.updateHostMetadata).not.toHaveBeenCalled();
    expect(
      (await service.query('canvas-a', ['thread-a'])).titles['thread-a'],
    ).toEqual({
      title: 'Original first prompt',
      source: 'fallback',
    });
    expect(
      (await service.query('canvas-b', ['thread-a'])).titles['thread-a'],
    ).toEqual({
      title: null,
      source: null,
    });
    expect(effectiveConversationTitle()).toEqual({ title: null, source: null });
  });

  it('subscribes before replaying a cached ACP title and retains it after blank updates', async () => {
    const { service, deps, metadata, getRecord } = fixture();
    metadata('Cached ACP');
    let finished = false;
    deps.notifications = vi.fn(() => {
      expect(deps.updateHostMetadata).not.toHaveBeenCalled();
      return (async function* () {
        expect(getRecord().hostMetadata).toEqual({
          [CONVERSATION_TITLE_METADATA_KEY]: {
            title: 'Cached ACP',
            source: 'acp',
          },
        });
        metadata('');
        yield { sessionInfo: { title: '', updatedAt: null } };
        finished = true;
      })();
    });
    service.subscribe('canvas-a', 'thread-a');
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'Cached ACP',
      source: 'acp',
    });
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('continues after a subscriber write failure and respects a manual rename', async () => {
    const { service, deps, getRecord } = fixture();
    const error = new Error('storage unavailable');
    vi.mocked(deps.updateHostMetadata).mockImplementationOnce(() => {
      throw error;
    });
    let finished = false;
    deps.notifications = vi.fn(async function* () {
      yield { sessionInfo: { title: 'Failed ACP', updatedAt: null } };
      yield { sessionInfo: { title: 'Recovered ACP', updatedAt: null } };
      expect(await service.get('canvas-a', 'thread-a')).toEqual({
        title: 'Recovered ACP',
        source: 'acp',
      });
      await service.setUserTitle('canvas-a', 'thread-a', 'Manual');
      yield { sessionInfo: { title: 'Late ACP', updatedAt: null } };
      finished = true;
    });
    service.subscribe('canvas-a', 'thread-a');
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(deps.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(getRecord().hostMetadata).toEqual({
      [CONVERSATION_TITLE_METADATA_KEY]: { title: 'Manual', source: 'user' },
    });
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('subscribes once per namespace and retains queued useful ACP after blanks', async () => {
    const { service, deps, records, metadata, getRecord } = fixture();
    metadata('');
    records.set('canvas-b/thread-a', {
      ...getRecord(),
      spec: { ...getRecord().spec, namespace: { name: 'canvas-b' } },
    });
    const finished: string[] = [];
    deps.notifications = vi.fn(async function* (canvasId) {
      yield { sessionInfo: { title: `${canvasId} first`, updatedAt: null } };
      yield {
        sessionInfo: { title: `${canvasId} last useful`, updatedAt: null },
      };
      yield { sessionInfo: { title: '  ', updatedAt: null } };
      finished.push(canvasId);
    });
    service.subscribe('canvas-a', 'thread-a');
    service.subscribe('canvas-b', 'thread-a');
    service.subscribe('canvas-a', 'thread-a');
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(deps.notifications).toHaveBeenCalledTimes(2);
    for (const canvas of ['canvas-a', 'canvas-b']) {
      expect(
        await new ConversationTitleService(deps).get(canvas, 'thread-a'),
      ).toEqual({ title: `${canvas} last useful`, source: 'acp' });
      expect(records.get(`${canvas}/thread-a`)?.hostMetadata).toEqual({
        [CONVERSATION_TITLE_METADATA_KEY]: {
          title: `${canvas} last useful`,
          source: 'acp',
        },
      });
      expect(
        records.get(`${canvas}/thread-a`)?.state.metadata?.sessionInfo?.title,
      ).toBe('');
    }
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    service.subscribe('canvas-a', 'thread-a');
    await vi.waitFor(() => expect(finished).toHaveLength(3));
  });
});
