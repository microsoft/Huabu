// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveQuestionBadgeChrome } from './questionBadgeChrome';
import {
  QuestionTakeoverMark,
  resolveQuestionBadgeBackground,
  resolveQuestionSpecialRingGeometry,
} from './QuestionTakeoverMark';

import type { QuestionAgentBadgeStatus } from './questionBadgeChrome';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('QuestionTakeoverMark', () => {
  it.each<QuestionAgentBadgeStatus>(['running', 'approval', 'done', 'error'])(
    'keeps the sticker background for %s',
    (status) => {
      const chrome = resolveQuestionBadgeChrome({
        status,
        agent: { kind: 'internal', alias: 'Huabu', mode: 'ask' },
        unread: false,
        conflictCount: 0,
      });

      expect(
        resolveQuestionBadgeBackground({
          isIdle: false,
          isOpen: chrome.isOpen,
          stickerFill: chrome.stickerFill,
        }),
      ).toBe(chrome.stickerFill);
    },
  );

  it('uses a static warning hold ring for approval', () => {
    const chrome = resolveQuestionBadgeChrome({
      status: 'approval',
      agent: { kind: 'internal', alias: 'Huabu', mode: 'ask' },
      unread: false,
      conflictCount: 0,
    });

    expect(chrome).toMatchObject({
      isApproval: true,
      isRunning: false,
      needsAttention: true,
      attentionColor: 'var(--warning)',
      ringBorderColor: 'transparent',
    });
  });

  it('scales special status rings with the mark size', () => {
    expect(resolveQuestionSpecialRingGeometry(6)).toEqual({
      inset: 0.5,
      width: 0.75,
    });
    expect(resolveQuestionSpecialRingGeometry(36)).toEqual({
      inset: 2,
      width: 3,
    });
    expect(resolveQuestionSpecialRingGeometry(84)).toEqual({
      inset: 3.5,
      width: 5,
    });
  });

  it('animates the avatar only while the question is running', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const renderMark = (status: QuestionAgentBadgeStatus) => {
      act(() => {
        root?.render(
          <QuestionTakeoverMark
            state={{ stage: 'collapsed', size: 30 }}
            status={status}
            agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
            unread={false}
            conflictCount={0}
            interactive={false}
          />,
        );
      });
    };

    renderMark('open');
    expect(container.querySelector('.agent-icon-working-body')).toBeNull();

    renderMark('running');
    expect(container.querySelector('.agent-icon-working-body')).not.toBeNull();
  });

  it('renders an interactive mark as an accessible button', () => {
    const onOpen = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <QuestionTakeoverMark
          state={{ stage: 'collapsed', size: 30 }}
          status="done"
          agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
          unread={false}
          conflictCount={0}
          interactive
          onOpen={onOpen}
          accessibleLabel="Huabu · Open conversation"
        />,
      );
    });

    // An accessible button via role — deliberately a div, not <Button>, so the
    // shared Button's icon-size utilities never clamp the size-driven avatar.
    const button = container.querySelector<HTMLElement>(
      '[role="button"][aria-label="Huabu · Open conversation"]',
    );
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('aria-hidden')).toBe(false);
    expect(button?.getAttribute('tabindex')).toBe('0');

    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
