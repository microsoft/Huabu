// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  dumpAssembledPrompt,
  isPromptDebugEnabled,
  type DumpPromptParams,
} from './debug-prompt.js';
const mocks = vi.hoisted(() => ({ extension: vi.fn(), append: vi.fn() }));
vi.mock('../../../storage/index.js', () => ({
  space: () => ({ extension: mocks.extension }),
}));
vi.mock('../../substrate-store.js', () => ({
  appendSubstrateLog: mocks.append,
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HUABU_DEBUG_PROMPT', '1');
  mocks.extension.mockResolvedValue({ kind: 'postgres', extensionId: 1 });
});
afterEach(() => vi.unstubAllEnvs());
const params = (warn = vi.fn()): DumpPromptParams => ({
  systemPrompt: 'system',
  messages: [],
  newMessageCount: 0,
  turnNumber: 1,
  threadId: 'thread',
  canvasId: 'space',
  mode: 'operate',
  logger: { warn } as never,
});
it('honors production defaults and explicit debug flags', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('HUABU_DEBUG_PROMPT', undefined);
  expect(isPromptDebugEnabled()).toBe(false);
  vi.stubEnv('HUABU_DEBUG_PROMPT', ' YES ');
  expect(isPromptDebugEnabled()).toBe(true);
  vi.stubEnv('HUABU_DEBUG_PROMPT', '0');
  dumpAssembledPrompt(params());
  expect(mocks.extension).not.toHaveBeenCalled();
});
it('awaits asynchronous append failures before advancing the queue', async () => {
  let reject!: (error: Error) => void;
  mocks.append
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    )
    .mockResolvedValue(undefined);
  const warn = vi.fn();
  dumpAssembledPrompt(params(warn));
  dumpAssembledPrompt({ ...params(warn), turnNumber: 2 });
  await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));
  // Both substrates are resolved at enqueue time, before either append completes.
  expect(mocks.extension).toHaveBeenCalledTimes(2);
  reject(new Error('async append failed'));
  await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(2));
  expect(warn).toHaveBeenCalledWith(
    { err: 'Error: async append failed' },
    expect.stringContaining('failed to write'),
  );
  expect(mocks.append.mock.calls[1][3]).toContain('TURN 2');
});
it('skips deleted-space substrates without attempting persistence', async () => {
  mocks.extension.mockResolvedValueOnce(null);
  dumpAssembledPrompt(params());
  // A later successful queue entry proves the earlier null entry was drained.
  dumpAssembledPrompt({ ...params(), turnNumber: 2 });
  await vi.waitFor(() => expect(mocks.append).toHaveBeenCalledTimes(1));
  expect(mocks.append.mock.calls[0][3]).toContain('TURN 2');
});
