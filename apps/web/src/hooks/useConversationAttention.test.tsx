// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import useCanvasStore from '@/store/canvasStore';

import { useConversationAttention } from './useConversationAttention';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const seen: Record<string, string | null> = {};

function Probe({
  name,
  ...target
}: {
  name: string;
  nodeId?: string;
  threadId?: string;
}) {
  seen[name] = useConversationAttention(target);
  return null;
}

const question = (id: string, data: Record<string, unknown>) =>
  ({
    id,
    type: 'question',
    position: { x: 0, y: 0 },
    data: { type: 'question', ...data },
  }) as never;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useCanvasStore.setState({ nodes: [] });
});

it('finds a conversation by node or by thread and follows viewing', async () => {
  useCanvasStore.setState({
    nodes: [
      question('q1', { status: 'done', threadId: 't1' }),
      question('q2', { status: 'error', viewed: true }),
    ],
  });
  await act(async () =>
    root.render(
      <>
        <Probe name="node" nodeId="q1" />
        <Probe name="thread" threadId="t1" />
        <Probe name="viewed" nodeId="q2" />
        <Probe name="other" />
      </>,
    ),
  );
  expect(seen).toEqual({
    node: 'done',
    thread: 'done',
    viewed: null,
    other: null,
  });
  await act(async () =>
    useCanvasStore.setState({
      nodes: [question('q1', { status: 'done', threadId: 't1', viewed: true })],
    }),
  );
  expect(seen.node).toBeNull();
  expect(seen.thread).toBeNull();
});
