// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  QuestionTakeoverMark,
  questionTakeoverMarkLayout,
  resolveQuestionSpecialRingGeometry,
} from './QuestionTakeoverMark';

import type { QuestionTakeoverMarkProps } from './QuestionTakeoverMark';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('@/components/Common/AgentAvatarMark', () => ({
  AgentAvatarMark: ({
    size,
    detail,
    motion,
  }: {
    size: number;
    detail: string;
    motion: string;
  }) => (
    <span
      data-avatar
      data-size={size}
      data-detail={detail}
      data-motion={motion}
    />
  ),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(props: Partial<QuestionTakeoverMarkProps> = {}) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(
      <QuestionTakeoverMark
        state={{ stage: 'collapsed', size: 128 }}
        status="done"
        agent={{ kind: 'internal', alias: 'Huabu', mode: 'ask' }}
        unread={false}
        conflictCount={0}
        interactive={false}
        {...props}
      />,
    ),
  );
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('QuestionTakeoverMark', () => {
  it.each(['idle', 'running', 'approval', 'error', 'done'] as const)(
    'replaces %s decoration with a scalable dot and restores the avatar',
    (status) => {
      const onBoundsChange = vi.fn();
      const onOpen = vi.fn();
      const props = {
        status,
        isOpen: true,
        unread: true,
        conflictCount: 2,
        interactive: true,
        onOpen,
        accessibleLabel: 'Open conversation',
        state: { stage: 'collapsed' as const, size: 12.8, onBoundsChange },
      };
      const el = render({ ...props, presentation: 'dot' });
      expect(el.querySelector('[data-question-takeover-dot]')).not.toBeNull();
      expect(el.querySelector('[data-avatar]')).toBeNull();
      expect(el.querySelector('svg')).toBeNull();
      expect(onBoundsChange).toHaveBeenLastCalledWith(0.66);
      const button = el.querySelector<HTMLElement>('[role="button"]');
      if (!button) throw new Error('Missing conversation button');
      expect(parseFloat(button.style.width)).toBeCloseTo(8.448);
      expect(button.style.width).toBe(button.style.height);
      expect(button.getAttribute('aria-label')).toBe('Open conversation');
      act(() => {
        button.click();
        for (const key of ['Enter', ' ']) {
          button.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        }
      });
      expect(onOpen).toHaveBeenCalledTimes(3);
      render({ ...props, presentation: 'avatar' });
      expect(el.querySelector('[data-question-takeover-dot]')).toBeNull();
      expect(el.querySelector('[data-avatar]')).not.toBeNull();
      expect(el.querySelector('.question-agent-badge-bubble')).not.toBeNull();
    },
  );

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

  it.each([0.005, 0.05, 0.1, 0.24, 1, 2])(
    'retains the full avatar at scale %s without a floor',
    (scale) => {
      const el = render({
        state: { stage: 'collapsed', size: 128 * scale },
        status: 'idle',
      });
      expect(
        el.querySelector('[data-avatar]')?.getAttribute('data-detail'),
      ).toBe('full');
      expect(el.querySelector('[data-avatar]')?.getAttribute('data-size')).toBe(
        '84.48',
      );
      expect(
        parseFloat((el.firstElementChild as HTMLElement).style.width),
      ).toBeCloseTo(84.48 * scale);
    },
  );

  it('keeps ring dimensions proportional without clamps', () => {
    for (const size of [0.6, 6, 36, 84, 840]) {
      expect(resolveQuestionSpecialRingGeometry(size)).toEqual({
        inset: size / 18,
        width: size / 12,
      });
    }
  });

  it.each([
    ['running', 'info'],
    ['approval', 'warning'],
    ['error', 'danger'],
    ['done', 'success'],
    ['idle', 'neutral'],
  ] as const)(
    'keeps open independent of %s lifecycle and palette',
    (status, tone) => {
      const el = render({ status, isOpen: true, unread: true });
      expect(el.firstElementChild?.getAttribute('data-state')).toBe(status);
      expect(el.firstElementChild?.getAttribute('data-tone')).toBe(tone);
      expect(el.querySelector('svg path')?.getAttribute('fill')).toBe(
        `var(--${tone === 'neutral' ? 'bg-hover' : `${tone}-bg`})`,
      );
      expect(
        el.querySelector('svg')?.style.getPropertyValue('--question-border'),
      ).toBe(`var(--${tone === 'neutral' ? 'fg-subtle' : `${tone}-light`})`);
      render({ status, isOpen: false, unread: true });
      expect(el.querySelector('.question-agent-badge-bubble')).toBeNull();
      expect(el.firstElementChild?.getAttribute('data-state')).toBe(status);
    },
  );

  it('keeps running motion while the bubble is open and restores the ring when it closes', () => {
    const el = render({ status: 'running', isOpen: true });
    expect(el.querySelector('[data-avatar]')?.getAttribute('data-motion')).toBe(
      'working',
    );
    expect(el.querySelector('.question-agent-ring-running')).toBeNull();
    render({ status: 'running', isOpen: false });
    expect(el.querySelector('[data-avatar]')?.getAttribute('data-motion')).toBe(
      'working',
    );
    expect(el.querySelector('.question-agent-ring-running')).not.toBeNull();
  });

  it('publishes visible bounds independently of zoom and encloses approval', () => {
    const onBoundsChange = vi.fn();
    render({
      status: 'approval',
      state: { stage: 'collapsed', size: 12.8, onBoundsChange },
    });
    expect(onBoundsChange).toHaveBeenLastCalledWith(
      questionTakeoverMarkLayout(true, true, false).diameter / 128,
    );
    render({
      status: 'approval',
      isOpen: true,
      state: { stage: 'collapsed', size: 6.4, onBoundsChange },
    });
    const layout = questionTakeoverMarkLayout(true, true, true);
    expect(onBoundsChange).toHaveBeenLastCalledWith(layout.diameter / 128);
    expect(layout.avatarTop - 84.48 * 0.45 * 0.3).toBeGreaterThanOrEqual(
      -1e-12,
    );
  });

  it('supports legacy open and explicit false override', () => {
    const el = render({ status: 'open' });
    expect(el.querySelector('.question-agent-badge-bubble')).not.toBeNull();
    render({ status: 'open', isOpen: false });
    expect(el.querySelector('.question-agent-badge-bubble')).toBeNull();
  });

  it('retains labelled click, Enter and Space activation', () => {
    const onOpen = vi.fn();
    const el = render({
      interactive: true,
      onOpen,
      accessibleLabel: 'Open conversation',
    });
    const button = el.querySelector<HTMLElement>('[role="button"]')!;
    expect(button.getAttribute('aria-label')).toBe('Open conversation');
    expect(button.tabIndex).toBe(0);
    act(() => {
      button.click();
      for (const key of ['Enter', ' '])
        button.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
    });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });
});
