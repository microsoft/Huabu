// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  findPendingPermissionRequest,
  findPendingPermissionRequestId,
} from './chatTypes';

import type { ChatMessage } from './chatTypes';

const permissionMessage = (resolution?: {
  optionId?: string;
  cancelled?: boolean;
}): ChatMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  segments: [
    {
      kind: 'permission',
      requestId: 'permission-1',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Run npm install',
      },
      options: [],
      resolution,
    },
  ],
});

describe('findPendingPermissionRequestId', () => {
  it('returns an unresolved permission request', () => {
    expect(findPendingPermissionRequestId([permissionMessage()])).toBe(
      'permission-1',
    );
    expect(findPendingPermissionRequest([permissionMessage()])).toMatchObject({
      messageId: 'assistant-1',
      part: { requestId: 'permission-1' },
    });
  });

  it.each([{ optionId: 'allow-once' }, { cancelled: true }])(
    'ignores a resolved permission request',
    (resolution) => {
      expect(
        findPendingPermissionRequestId([permissionMessage(resolution)]),
      ).toBeNull();
    },
  );

  it('ignores non-assistant messages', () => {
    expect(
      findPendingPermissionRequestId([
        { id: 'user-1', role: 'user', content: 'Install dependencies' },
      ]),
    ).toBeNull();
  });
});
