// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Custom properties are saved as a per-key patch without a revision; the
 * content revision belongs to the body. A property change by anyone never
 * refuses a body save, a body change never refuses a property save, and each
 * arrives on this page while the other is still unsaved here.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ApiError } from '@/api/_client';
import {
  CanvasConflictError,
  getNodeContent,
  putNodeContent,
} from '@/api/canvas';
import { dismissToast, toast } from '@/components/Common/Toast';

import { createNodeContentQueue } from '../nodeContentQueue';
import { unsavedFields } from './unsavedFields';

import type * as CanvasApi from '@/api/canvas';
import type { GetNodeContentResponse } from '@huabu/shared';
import type { Node } from '@xyflow/react';

vi.mock('@/api/canvas', async (importActual) => {
  const actual = await importActual<typeof CanvasApi>();
  return { ...actual, getNodeContent: vi.fn(), putNodeContent: vi.fn() };
});

vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(),
  dismissToast: vi.fn(),
}));

const putMock = putNodeContent as unknown as Mock;
const getMock = getNodeContent as unknown as Mock;
const toastMock = toast as unknown as Mock;
const dismissMock = dismissToast as unknown as Mock;

const stale = (extra: { propertiesApplied?: boolean } = {}) =>
  new CanvasConflictError({
    code: 'NODE_CONTENT_CONFLICT',
    message: 'stale',
    currentRev: 'rev-other',
    ...extra,
  });

function setup() {
  const node = {
    id: 'n1',
    type: 'note',
    position: { x: 0, y: 0 },
    data: {
      content: 'body',
      label: 'Note',
      properties: { Venue: 'UIST', Year: 2024 },
      propertyDisplayKeys: ['Venue', 'Year'],
    },
  } as Node;
  const state = {
    canvasId: 'c1',
    isLoading: false,
    nodes: [node] as Node[],
    _setStateRaw: vi.fn(({ nodes }: { nodes: Node[] }) => {
      state.nodes = nodes;
    }),
    patchNodeSilent: vi.fn(),
  };
  const adopted = vi.fn();
  const queue = createNodeContentQueue({
    delayMs: 0,
    getState: () => state,
    onRemoteContentAdopted: adopted,
    pageId: 'page-1',
  });
  queue.setBaselines([node], { n1: 'rev-0' });
  /** A local edit of the node, as the store makes it. */
  const edit = (patch: Record<string, unknown>) => {
    const before = state.nodes;
    state.nodes = before.map((item) => {
      if (item.id !== 'n1') return item;
      const data: Record<string, unknown> = { ...item.data, ...patch };
      for (const [key, value] of Object.entries(patch))
        if (value === undefined) delete data[key];
      return { ...item, data };
    });
    queue.scheduleChanges('c1', before, state.nodes);
  };
  return { queue, state, node, adopted, edit };
}

const server = (
  patch: Partial<GetNodeContentResponse> = {},
): GetNodeContentResponse =>
  ({
    nodeId: 'n1',
    type: 'note',
    content: 'body',
    label: 'Note',
    properties: { Venue: 'UIST', Year: 2024 },
    propertyDisplayKeys: ['Venue', 'Year'],
    rev: 'rev-0',
    ...patch,
  }) as GetNodeContentResponse;

const saved = (rev: string) => ({ nodeId: 'n1', label: 'Note', rev });

/** A request that settles when the test says so. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  putMock.mockReset();
  getMock.mockReset();
  toastMock.mockReset();
  dismissMock.mockReset();
});

describe('a property edit', () => {
  it('is sent as its own keys, without a revision, a body or a title', async () => {
    const { queue, state } = setup();
    putMock.mockResolvedValueOnce(saved('rev-0'));

    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read', Year: null },
      propertyDisplayKeys: ['Venue', 'Status'],
    });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2]).toEqual({
      nodeType: 'note',
      properties: { Status: 'Read', Year: null },
      propertyDisplayKeys: ['Venue', 'Status'],
      pageId: 'page-1',
    });
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'UIST',
      Status: 'Read',
    });
    expect(state.nodes[0].data.propertyDisplayKeys).toEqual([
      'Venue',
      'Status',
    ]);
    expect(getMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
    expect(queue.hasUnsavedContent('c1')).toBe(false);
  });

  it('does not move the baseline of the body: the next body save quotes the revision the page shows', async () => {
    const { queue, edit } = setup();
    // Another page saved the body meanwhile; the property save's answer
    // names that revision, which this page has never shown.
    putMock.mockResolvedValueOnce(saved('rev-of-a-body-not-shown-here'));
    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
    });

    putMock.mockResolvedValueOnce(saved('rev-1'));
    edit({ content: 'body, typed on' });
    await queue.flushNow('c1', 'n1');

    expect(putMock).toHaveBeenCalledTimes(2);
    const body = putMock.mock.calls[1][2];
    expect(body.expectRev).toBe('rev-0');
    expect(body.content).toBe('body, typed on');
    // The body save says nothing about properties.
    expect(body).not.toHaveProperty('properties');
    expect(body).not.toHaveProperty('propertyDisplayKeys');
  });

  it('of another key than another page changed needs no fetch and no second request', async () => {
    const { queue, state } = setup();
    // The server answers what it answers now for a patch of another key
    // than the one the other page changed meanwhile: accepted.
    putMock.mockResolvedValueOnce(saved('rev-0'));

    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
    });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2]).not.toHaveProperty('expectRev');
    expect(getMock).not.toHaveBeenCalled();
    expect(state.nodes[0].data.properties).toMatchObject({ Status: 'Read' });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('goes out while a body of the node is unsaved, and leaves that body queued with its own revision', async () => {
    const { queue, edit } = setup();
    edit({ content: 'typing' });
    putMock.mockResolvedValueOnce(saved('rev-0'));

    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
    });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2]).toEqual({
      nodeType: 'note',
      properties: { Status: 'Read' },
      pageId: 'page-1',
    });
    // The body is still unsaved and still goes out, by itself.
    expect(queue.unsavedNodeIds('c1')).toEqual(['n1']);
    putMock.mockResolvedValueOnce(saved('rev-1'));
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[1][2]).toMatchObject({
      content: 'typing',
      expectRev: 'rev-0',
    });
    expect(putMock.mock.calls[1][2]).not.toHaveProperty('properties');
  });

  it('goes out for a node frozen by a body conflict, which stays frozen', async () => {
    const { queue, edit, state } = setup();
    putMock.mockRejectedValueOnce(stale());
    getMock.mockResolvedValueOnce(server({ content: 'theirs', rev: 'rev-x' }));
    edit({ content: 'mine' });
    await queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(toastMock).toHaveBeenCalledTimes(1);

    putMock.mockResolvedValueOnce(saved('rev-x'));
    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
    });

    expect(putMock.mock.calls[1][2]).toEqual({
      nodeType: 'note',
      properties: { Status: 'Read' },
      pageId: 'page-1',
    });
    expect(state.nodes[0].data).toMatchObject({
      content: 'mine',
      properties: { Status: 'Read' },
    });
    // Still the user's to answer: nothing more was sent for the body.
    expect(queue.unsavedNodeIds('c1')).toEqual(['n1']);
    expect(toastMock).toHaveBeenCalledTimes(1);
    await queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it('changed in the store for a frozen node keeps the conflict and its choice when its save fails', async () => {
    const { queue, edit } = setup();
    toastMock.mockReturnValue('conflict-toast');
    putMock.mockRejectedValueOnce(stale());
    getMock.mockResolvedValueOnce(server({ content: 'theirs', rev: 'rev-x' }));
    edit({ content: 'mine' });
    await queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(toastMock).toHaveBeenCalledTimes(1);
    dismissMock.mockClear();

    // An undo of a property edit while the conflict is open; offline.
    putMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    edit({ properties: { Venue: 'UIST', Year: 2025 } });
    await queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(putMock.mock.calls[1][2]).toEqual({
      nodeType: 'note',
      properties: { Year: 2025 },
      pageId: 'page-1',
    });
    // No second toast, and the Keep mine / Load latest one is still there.
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(dismissMock).not.toHaveBeenCalled();
    expect(unsavedFields(queue, 'n1')).toEqual(['content', 'properties']);

    // Keep mine sends the body, and the property that is still unsaved.
    putMock.mockResolvedValueOnce(saved('rev-2'));
    toastMock.mock.calls[0][1].secondaryAction.onClick();
    await tick();
    await queue.waitForIdle();
    expect(putMock.mock.calls[2][2]).toMatchObject({
      content: 'mine',
      expectRev: 'rev-other',
      properties: { Year: 2025 },
    });
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
  });

  it('that genuinely fails is reported to its caller, changes nothing and records no body failure', async () => {
    const { queue, state } = setup();
    for (const error of [
      new ApiError(500, { message: 'boom' }, 'Server Error'),
      new ApiError(403, { message: 'denied' }, 'Forbidden'),
      new TypeError('Failed to fetch'),
    ]) {
      putMock.mockRejectedValueOnce(error);
      await expect(
        queue.commitProperties('c1', 'n1', { properties: { Status: 'Read' } }),
      ).rejects.toBe(error);
    }
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'UIST',
      Year: 2024,
    });
    // The caller owns the report and its Retry; the queue shows none and
    // holds nothing unsaved for the node.
    expect(toastMock).not.toHaveBeenCalled();
    expect(queue.hasUnsavedContent('c1')).toBe(false);
    expect(queue.unsavedNodeIds('c1')).toEqual([]);

    // The same edit, made again, is sent again.
    putMock.mockResolvedValueOnce(saved('rev-0'));
    await queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
    });
    expect(state.nodes[0].data.properties).toMatchObject({ Status: 'Read' });
  });
});

describe('a property changed by somebody else while a body is unsaved here', () => {
  it('is shown, the text is kept, and the body save is accepted without a word', async () => {
    const { queue, state, edit, adopted } = setup();
    edit({ content: 'typing' });
    // Another page's save: a tag added, the body as the server had it.
    getMock.mockResolvedValueOnce(
      server({
        properties: { Venue: 'UIST', Year: 2024, tags: ['physics'] },
        propertyDisplayKeys: ['tags', 'Venue', 'Year'],
      }),
    );

    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe(
      'kept-local',
    );

    expect(state.nodes[0].data).toMatchObject({
      content: 'typing',
      properties: { Venue: 'UIST', Year: 2024, tags: ['physics'] },
      propertyDisplayKeys: ['tags', 'Venue', 'Year'],
    });
    expect(adopted).toHaveBeenCalledExactlyOnceWith('c1', 'n1', {
      properties: { Venue: 'UIST', Year: 2024, tags: ['physics'] },
      propertyDisplayKeys: ['tags', 'Venue', 'Year'],
    });

    putMock.mockResolvedValueOnce(saved('rev-1'));
    getMock.mockResolvedValue(
      server({
        content: 'typing',
        rev: 'rev-1',
        properties: { Venue: 'UIST', Year: 2024, tags: ['physics'] },
        propertyDisplayKeys: ['tags', 'Venue', 'Year'],
      }),
    );
    await queue.flushNow('c1', 'n1');
    const body = putMock.mock.calls[0][2];
    expect(body).toMatchObject({ content: 'typing', expectRev: 'rev-0' });
    // Their tag is not sent back, and certainly not as a removal.
    expect(body).not.toHaveProperty('properties');
    expect(toastMock).not.toHaveBeenCalled();
    await tick();
    expect(queue.unsavedNodeIds('c1')).toEqual([]);
    expect(state.nodes[0].data).toMatchObject({
      content: 'typing',
      properties: { tags: ['physics'] },
    });
  });

  it('removes here what they removed, and leaves the body of a save in flight alone', async () => {
    const { queue, state, edit } = setup();
    const request = held<ReturnType<typeof saved>>();
    putMock.mockReturnValueOnce(request.promise);
    edit({ content: 'typing' });
    const saving = queue.flushNow('c1', 'n1');
    await tick();

    getMock.mockResolvedValueOnce(
      server({ properties: undefined, propertyDisplayKeys: undefined }),
    );
    await queue.adoptRemoteContent('c1', 'n1');
    expect(state.nodes[0].data).not.toHaveProperty('properties');
    expect(state.nodes[0].data).not.toHaveProperty('propertyDisplayKeys');
    expect(state.nodes[0].data.content).toBe('typing');

    getMock.mockResolvedValue(
      server({
        content: 'typing',
        rev: 'rev-1',
        properties: undefined,
        propertyDisplayKeys: undefined,
      }),
    );
    request.resolve(saved('rev-1'));
    await saving;
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('does not bring their body in: a body they changed too is still the conflict it was', async () => {
    const { queue, state, edit } = setup();
    edit({ content: 'mine' });
    const theirs = server({
      content: 'theirs',
      rev: 'rev-theirs',
      properties: { Venue: 'CHI' },
    });
    getMock.mockResolvedValue(theirs);
    await queue.adoptRemoteContent('c1', 'n1');
    expect(state.nodes[0].data).toMatchObject({
      content: 'mine',
      properties: { Venue: 'CHI' },
    });

    putMock.mockRejectedValueOnce(stale());
    await queue.flushNow('c1', 'n1').catch(() => undefined);
    expect(putMock.mock.calls[0][2].expectRev).toBe('rev-0');
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(state.nodes[0].data.content).toBe('mine');
  });

  it('keeps a property this page has itself changed and not saved yet', async () => {
    const { queue, state, edit } = setup();
    // An undo of a property edit: a store change, saved by the queue.
    edit({ properties: { Venue: 'UIST', Year: 2025 } });
    getMock.mockResolvedValueOnce(
      server({ properties: { Venue: 'CHI', Year: 2024, tags: ['x'] } }),
    );
    await queue.adoptRemoteContent('c1', 'n1');
    // Their keys arrive; the key changed here stays as it is here.
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'CHI',
      Year: 2025,
      tags: ['x'],
    });
    // Its own save then sends its own key and none of theirs.
    putMock.mockResolvedValueOnce(saved('rev-0'));
    getMock.mockResolvedValue(
      server({ properties: { Venue: 'CHI', Year: 2025, tags: ['x'] } }),
    );
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[0][2].properties).toEqual({ Year: 2025 });
    await tick();
  });
});

describe('a body changed by somebody else while a property edit is on the wire', () => {
  it('is shown at once with its revision, and the property edit lands on top', async () => {
    const { queue, state, edit } = setup();
    const request = held<ReturnType<typeof saved>>();
    putMock.mockReturnValueOnce(request.promise);
    const saving = queue.commitProperties('c1', 'n1', {
      properties: { Status: 'Read' },
    });
    await tick();
    expect(putMock).toHaveBeenCalledTimes(1);
    // A property edit on the wire is not unsaved content of the node.
    expect(queue.unsavedNodeIds('c1')).toEqual([]);

    getMock.mockResolvedValueOnce(
      server({ content: 'their body', label: 'Theirs', rev: 'rev-theirs' }),
    );
    await expect(queue.adoptRemoteContent('c1', 'n1')).resolves.toBe('applied');
    expect(state.nodes[0].data).toMatchObject({
      content: 'their body',
      label: 'Theirs',
    });

    // The fetch read the server before this page's patch was written.
    getMock.mockResolvedValueOnce(
      server({
        content: 'their body',
        label: 'Theirs',
        rev: 'rev-theirs',
        properties: { Venue: 'UIST', Year: 2024, Status: 'Read' },
      }),
    );
    request.resolve(saved('rev-theirs'));
    await saving;
    await tick();
    expect(state.nodes[0].data).toMatchObject({
      content: 'their body',
      label: 'Theirs',
      properties: { Venue: 'UIST', Year: 2024, Status: 'Read' },
    });
    expect(toastMock).not.toHaveBeenCalled();

    // The next body save descends from the body the page shows.
    putMock.mockResolvedValueOnce(saved('rev-2'));
    edit({ content: 'their body, and more' });
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[1][2]).toMatchObject({
      content: 'their body, and more',
      expectRev: 'rev-theirs',
    });
  });

  it('ends with what the server holds when the other writer set the same key last', async () => {
    const { queue, state } = setup();
    const request = held<ReturnType<typeof saved>>();
    putMock.mockReturnValueOnce(request.promise);
    const saving = queue.commitProperties('c1', 'n1', {
      properties: { Venue: 'CHI' },
    });
    await tick();
    // Their save of the same key was written after this page's patch and is
    // fetched before this page's answer arrives.
    getMock.mockResolvedValueOnce(
      server({ properties: { Venue: 'CSCW', Year: 2024 } }),
    );
    await queue.adoptRemoteContent('c1', 'n1');
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'CSCW',
      Year: 2024,
    });

    // Once answered, the page reads the node again: the last writer's value.
    getMock.mockResolvedValueOnce(
      server({ properties: { Venue: 'CSCW', Year: 2024 } }),
    );
    request.resolve(saved('rev-0'));
    await saving;
    await tick();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(state.nodes[0].data.properties).toEqual({
      Venue: 'CSCW',
      Year: 2024,
    });
    expect(toastMock).not.toHaveBeenCalled();
  });
});

describe('a property changed in the store (undo, redo, a paste)', () => {
  it('is saved as the keys that changed, a removed key as null, without a revision or a body', async () => {
    const { queue, edit } = setup();
    putMock.mockResolvedValueOnce(saved('rev-0'));
    edit({
      properties: { Venue: 'UIST', Status: 'Read' },
      propertyDisplayKeys: ['Status', 'Venue'],
    });
    await queue.flushNow('c1', 'n1');

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0][2]).toEqual({
      nodeType: 'note',
      properties: { Status: 'Read', Year: null },
      propertyDisplayKeys: ['Status', 'Venue'],
      pageId: 'page-1',
    });
    expect(queue.unsavedNodeIds('c1')).toEqual([]);

    // The body's baseline did not move with it.
    putMock.mockResolvedValueOnce(saved('rev-1'));
    edit({ content: 'typed' });
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[1][2].expectRev).toBe('rev-0');
  });

  it('does not send another writer’s keys back, also after they changed since the load', async () => {
    const { queue, edit } = setup();
    // The other page's tag arrived; this page then undoes its own Year edit.
    getMock.mockResolvedValueOnce(
      server({ properties: { Venue: 'UIST', Year: 2024, tags: ['x'] } }),
    );
    await queue.adoptRemoteContent('c1', 'n1');
    putMock.mockResolvedValueOnce(saved('rev-0'));
    edit({ properties: { Venue: 'UIST', Year: 2023, tags: ['x'] } });
    await queue.flushNow('c1', 'n1');
    expect(putMock.mock.calls[0][2].properties).toEqual({ Year: 2023 });
  });

  it('travels with a body changed at the same time, and is settled although that body is refused', async () => {
    const { queue, state, edit } = setup();
    edit({ content: 'mine', properties: { Venue: 'CHI', Year: 2024 } });
    putMock.mockRejectedValueOnce(stale({ propertiesApplied: true }));
    getMock.mockResolvedValue(server({ content: 'theirs', rev: 'rev-other' }));
    await queue.flushNow('c1', 'n1').catch(() => undefined);

    expect(putMock.mock.calls[0][2]).toMatchObject({
      content: 'mine',
      properties: { Venue: 'CHI' },
      expectRev: 'rev-0',
    });
    // The body is the user's to answer; the property is saved.
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(unsavedFields(queue, 'n1')).toEqual(['content']);
    expect(state.nodes[0].data).toMatchObject({
      content: 'mine',
      properties: { Venue: 'CHI', Year: 2024 },
    });

    // Keep mine sends the body alone.
    putMock.mockResolvedValueOnce(saved('rev-2'));
    const keepMine = toastMock.mock.calls[0][1].secondaryAction.onClick;
    keepMine();
    await tick();
    await queue.waitForIdle();
    const kept = putMock.mock.calls[1][2];
    expect(kept).toMatchObject({ content: 'mine', expectRev: 'rev-other' });
    expect(kept).not.toHaveProperty('properties');
  });
});

describe('what counts as the same content', () => {
  it('is the body: a refused save whose body the server holds is settled although the properties differ', async () => {
    const { queue, state, edit } = setup();
    edit({ content: 'same text' });
    putMock.mockRejectedValueOnce(stale());
    getMock.mockResolvedValueOnce(
      server({
        content: 'same text',
        rev: 'rev-other',
        properties: { Venue: 'CHI' },
        propertyDisplayKeys: ['Venue'],
      }),
    );
    putMock.mockResolvedValueOnce(saved('rev-other'));
    await queue.flushNow('c1', 'n1');

    expect(toastMock).not.toHaveBeenCalled();
    expect(putMock.mock.calls[1][2].expectRev).toBe('rev-other');
    expect(state.nodes[0].data.content).toBe('same text');
  });
});
