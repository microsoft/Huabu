// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  composeNotice,
  createTurnWatcher,
  firstSentence,
  readConversations,
  unseenIn,
  type TurnEvent,
} from './turnNotices';

import type { ChatMessage } from '@/store/chatTypes';

const question = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  data: { type: 'question', label: 'Plan', ...data },
});

const reply = (text: string): ChatMessage => ({
  id: 'm2',
  role: 'assistant',
  segments: [{ kind: 'text', text }] as never,
});

const thread = (patch: {
  messages?: ChatMessage[];
  isStreaming?: boolean;
  completedTurnId?: string;
}) => ({ messages: [], isStreaming: false, ...patch });

const wording = {
  done: 'Finished',
  error: 'Failed',
  approval: 'Waiting for your approval',
  several: (count: number) => `${count} conversations have news`,
};

describe('firstSentence', () => {
  it('takes the opening sentence and drops Markdown markers', () => {
    expect(firstSentence('\n## **Done.** More follows.')).toBe('Done.');
    expect(firstSentence('写好了。接下来')).toBe('写好了。');
    expect(firstSentence('See v1.2 for details\nnext line')).toBe(
      'See v1.2 for details',
    );
    expect(firstSentence('x'.repeat(200))).toHaveLength(140);
  });
});

describe('turn watcher', () => {
  it('reports nothing for what a page finds when it opens', () => {
    const watcher = createTurnWatcher();
    const nodes = [question('n1', { threadId: 't1', status: 'done' })];
    expect(watcher.take(readConversations(nodes, {}))).toEqual([]);
    // History arriving afterwards is not news either.
    const loaded = {
      t1: thread({
        messages: [{ id: 'm3', role: 'status', status: 'error' }],
      }),
    };
    expect(watcher.take(readConversations(nodes, loaded))).toEqual([]);
  });

  it('reports a turn that ran here with the opening of its reply', () => {
    const watcher = createTurnWatcher();
    const nodes = [question('n1', { threadId: 't1' })];
    watcher.take(readConversations(nodes, { t1: thread({}) }));
    watcher.take(
      readConversations(nodes, { t1: thread({ isStreaming: true }) }),
    );
    const done = {
      t1: thread({
        completedTurnId: 'm2',
        messages: [reply('The plan is ready. Details below.')],
      }),
    };
    expect(watcher.take(readConversations(nodes, done))).toEqual([
      {
        key: 't1',
        kind: 'done',
        nodeId: 'n1',
        label: 'Plan',
        text: 'The plan is ready.',
      },
    ]);
    expect(watcher.take(readConversations(nodes, done))).toEqual([]);
  });

  it('reports a conversation running elsewhere through its node', () => {
    const watcher = createTurnWatcher();
    watcher.take(
      readConversations([question('n1', { status: 'running' })], {}),
    );
    const events = watcher.take(
      readConversations(
        [question('n1', { status: 'error', errorMessage: 'No quota' })],
        {},
      ),
    );
    expect(events).toMatchObject([
      { key: 'n1', kind: 'error', text: 'No quota' },
    ]);
  });

  it('reports an approval once and the end of the same turn after it', () => {
    const watcher = createTurnWatcher();
    const waiting = {
      t1: thread({
        messages: [
          {
            id: 'm2',
            role: 'assistant',
            segments: [{ kind: 'permission', requestId: 'r1' }] as never,
          },
        ],
      }),
    };
    watcher.take(readConversations([], { t1: thread({ isStreaming: true }) }));
    expect(watcher.take(readConversations([], waiting))).toMatchObject([
      { key: 't1', kind: 'approval', nodeId: null },
    ]);
    expect(watcher.take(readConversations([], waiting))).toEqual([]);
    expect(
      watcher.take(
        readConversations([], { t1: thread({ completedTurnId: 'm2' }) }),
      ),
    ).toMatchObject([{ kind: 'done' }]);
  });

  it('reports nothing for a turn the person stopped', () => {
    const watcher = createTurnWatcher();
    watcher.take(readConversations([], { t1: thread({ isStreaming: true }) }));
    expect(watcher.take(readConversations([], { t1: thread({}) }))).toEqual([]);
  });
});

describe('unseenIn', () => {
  it('counts conversations holding something unseen and names the most pressing', () => {
    const waiting = thread({
      messages: [
        {
          id: 'm2',
          role: 'assistant',
          segments: [{ kind: 'permission', requestId: 'r1' }] as never,
        },
      ],
    });
    const nodes = [
      question('n1', { status: 'done' }),
      question('n2', { status: 'error', viewed: true }),
      question('n3', { status: 'done', viewed: true, threadId: 't3' }),
      question('n4', { status: 'running' }),
    ];
    expect(unseenIn(readConversations(nodes, {}))).toEqual({
      attention: 'done',
      unseen: 1,
    });
    // A bare thread records no viewing; it can only await an approval.
    expect(
      unseenIn(
        readConversations(nodes, {
          t3: waiting,
          t9: thread({ completedTurnId: 'm2' }),
        }),
      ),
    ).toEqual({ attention: 'approval', unseen: 2 });
    expect(unseenIn(readConversations([], {}))).toEqual({
      attention: null,
      unseen: 0,
    });
  });
});

describe('composeNotice', () => {
  const event = (patch: Partial<TurnEvent> = {}): TurnEvent => ({
    key: 't1',
    kind: 'done',
    nodeId: 'n1',
    label: 'Plan',
    text: 'The plan is ready.',
    ...patch,
  });
  const on = { done: true, needsYou: true };

  it('words a single event by its kind', () => {
    expect(composeNotice([event()], 'Space', wording, on)).toEqual({
      keys: ['t1'],
      title: 'Plan · Space',
      body: 'The plan is ready.',
      nodeIds: ['n1'],
    });
    expect(
      composeNotice(
        [event({ kind: 'error', text: 'No quota', label: '' })],
        'Space',
        wording,
        on,
      ),
    ).toMatchObject({ title: 'Space', body: 'Failed: No quota' });
    expect(
      composeNotice([event({ kind: 'approval' })], 'Space', wording, on),
    ).toMatchObject({ body: 'Waiting for your approval' });
  });

  it('opens a finished turn on what it left unseen, anything else on the conversation', () => {
    expect(
      composeNotice(
        [event({ outputIds: ['out-1', 'out-2'] })],
        'Space',
        wording,
        on,
      )?.nodeIds,
    ).toEqual(['out-1', 'out-2']);
    expect(
      composeNotice(
        [event({ kind: 'approval', outputIds: ['out-1'] })],
        'Space',
        wording,
        on,
      )?.nodeIds,
    ).toEqual(['n1']);
    expect(
      composeNotice([event({ outputIds: [] })], 'Space', wording, on)?.nodeIds,
    ).toEqual(['n1']);
  });

  it('tells several conversations as one and keeps the latest of each', () => {
    expect(
      composeNotice(
        [
          event({ kind: 'approval' }),
          event(),
          event({ key: 't2', nodeId: 'n2' }),
        ],
        'Space',
        wording,
        on,
      ),
    ).toEqual({
      keys: ['t1', 't2'],
      title: 'Space',
      body: '2 conversations have news',
      nodeIds: ['n1', 'n2'],
    });
  });

  it('leaves out what the preferences silence', () => {
    const events = [event(), event({ key: 't2', kind: 'error', nodeId: 'n2' })];
    expect(
      composeNotice(events, 'Space', wording, { done: false, needsYou: true }),
    ).toMatchObject({ keys: ['t2'], nodeIds: ['n2'] });
    expect(
      composeNotice([event()], 'Space', wording, {
        done: false,
        needsYou: true,
      }),
    ).toBeNull();
    expect(composeNotice([], 'Space', wording, on)).toBeNull();
  });
});
