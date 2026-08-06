// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PermissionCard, PermissionTray } from './PermissionCard';

import type { PermissionSegment } from '../../../store/chatTypes';

const respondAcpPermission = vi.fn().mockResolvedValue({});
const updateMessage = vi.fn();

vi.mock('../../../api/acp', () => ({
  respondAcpPermission: (...args: unknown[]) => respondAcpPermission(...args),
}));

vi.mock('../../../store/chatStore', () => ({
  useChatStore: (
    selector: (state: { updateMessage: typeof updateMessage }) => unknown,
  ) => selector({ updateMessage }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'messages.permissionRequested': 'Permission requested',
        'messages.permissionRequestAria': 'Agent permission request',
        'messages.cancelled': 'Cancelled',
        'messages.decided': 'Decided',
      })[key] ?? key,
  }),
}));

const part: PermissionSegment = {
  kind: 'permission',
  requestId: 'permission-1',
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Fetch web content',
    rawInput: { url: 'https://example.com' },
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  respondAcpPermission.mockClear();
  updateMessage.mockClear();
});

describe('ACP permission surfaces', () => {
  it('keeps the MessageList record passive without repeating the pending status', () => {
    render(<PermissionCard part={part} />);

    expect(container?.textContent).toContain('Fetch web content');
    expect(container?.textContent).not.toContain('Permission requested');
    expect(container?.querySelector('button')).toBeNull();
  });

  it('appends the outcome once the request is resolved', () => {
    render(
      <PermissionCard
        part={{ ...part, resolution: { optionId: 'allow-once' } }}
      />,
    );

    expect(container?.textContent).toContain('Fetch web content·Allow once');
    expect(container?.querySelector('button')).toBeNull();
  });

  it('makes the composer tray the only actionable surface', async () => {
    render(
      <PermissionTray
        threadId="thread-1"
        messageId="assistant-1"
        part={part}
      />,
    );

    const buttons = [...(container?.querySelectorAll('button') ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Allow once',
      'Always allow',
      'Deny',
    ]);

    await act(async () => {
      buttons[0]?.click();
    });

    expect(updateMessage).toHaveBeenCalledWith(
      'thread-1',
      'assistant-1',
      expect.any(Function),
    );
    expect(respondAcpPermission).toHaveBeenCalledWith('thread-1', {
      requestId: 'permission-1',
      optionId: 'allow-once',
    });
  });
});
