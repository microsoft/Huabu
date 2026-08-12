// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  handleStreamEvent,
  registerAcpSessionMetaSink,
} from './useAgentStream';

import type { AgentStreamEvent } from '@huabu/shared';

const modeUpdate = {
  type: 'session_mode_update',
  data: { currentModeId: 'operate' },
} as AgentStreamEvent;

describe('ACP session metadata routing', () => {
  it('dispatches updates only to the sink registered for the owning thread', () => {
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    const unregisterFirst = registerAcpSessionMetaSink('thread-1', firstSink);
    const unregisterSecond = registerAcpSessionMetaSink('thread-2', secondSink);

    handleStreamEvent(modeUpdate, {
      threadId: 'thread-1',
      assistantId: 'assistant-1',
    });

    expect(firstSink).toHaveBeenCalledOnce();
    expect(firstSink).toHaveBeenCalledWith(modeUpdate);
    expect(secondSink).not.toHaveBeenCalled();

    unregisterFirst();
    unregisterSecond();
  });

  it('unregisters one thread without disturbing another', () => {
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    const unregisterFirst = registerAcpSessionMetaSink('thread-1', firstSink);
    const unregisterSecond = registerAcpSessionMetaSink('thread-2', secondSink);

    unregisterFirst();
    handleStreamEvent(modeUpdate, {
      threadId: 'thread-2',
      assistantId: 'assistant-2',
    });

    expect(firstSink).not.toHaveBeenCalled();
    expect(secondSink).toHaveBeenCalledOnce();

    unregisterSecond();
  });

  it('does not let stale cleanup remove a replacement sink', () => {
    const staleSink = vi.fn();
    const currentSink = vi.fn();
    const unregisterStale = registerAcpSessionMetaSink('thread-1', staleSink);
    const unregisterCurrent = registerAcpSessionMetaSink(
      'thread-1',
      currentSink,
    );

    unregisterStale();
    handleStreamEvent(modeUpdate, {
      threadId: 'thread-1',
      assistantId: 'assistant-1',
    });

    expect(staleSink).not.toHaveBeenCalled();
    expect(currentSink).toHaveBeenCalledOnce();

    unregisterCurrent();
  });
});
