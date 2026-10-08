// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Popover } from '@/components/Common/Popover';
import en from '@/i18n/resources/en/common.json';
import zh from '@/i18n/resources/zh-CN/common.json';

import {
  InkAgentDestinationPicker,
  type InkAgentConversationOption,
  type InkAgentDestinationPickerProps,
} from './InkAgentDestinationPicker';

import type { AgentAvatarMarkProps } from '@/components/Common/AgentAvatarMark';
import type { AgentBinding, AgentProfileView } from '@huabu/shared';

vi.mock('@/components/Common/AgentAvatarMark', () => ({
  AgentAvatarMark: ({ agent }: AgentAvatarMarkProps) => (
    <span data-avatar={JSON.stringify(agent)} />
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const i18n = createInstance();
const ancestorPointer = vi.fn();
const ancestorClick = vi.fn();
const binding: AgentBinding = {
  kind: 'external',
  profileId: 'reviewer',
  alias: 'Old alias',
};
const profiles: AgentProfileView[] = [
  {
    id: 'reviewer',
    alias: 'Reviewer',
    agentletId: 'machine-a',
    workingDirPath: '/work/reviewer',
    launch: { kind: 'acp-command', command: 'copilot --acp' },
  },
];
const conversations: InkAgentConversationOption[] = [
  { nodeId: 'first', title: 'First review', binding, mode: 'ask' },
  {
    nodeId: 'busy',
    title: 'Busy review',
    binding,
    mode: 'ask',
    disabledReason: 'Running',
  },
  { nodeId: 'second', title: 'Second review', binding, mode: 'operate' },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let props: InkAgentDestinationPickerProps;

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

async function render(
  overrides: Partial<InkAgentDestinationPickerProps> = {},
  insidePopover = false,
) {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      binding,
      mode: 'operate',
      profiles,
      conversations,
      onNewConversation: vi.fn(),
      onContinueConversation: vi.fn(),
      onRefreshProfiles: vi.fn(),
    };
  }
  props = { ...props, ...overrides };
  await act(async () => {
    const picker = (
      <div
        role="presentation"
        onPointerDown={ancestorPointer}
        onClick={ancestorClick}
      >
        <InkAgentDestinationPicker {...props} />
      </div>
    );
    root?.render(
      <I18nextProvider i18n={i18n}>
        {insidePopover ? (
          <Popover position={{ x: 100, y: 100 }} className="picker-test-parent">
            {picker}
          </Popover>
        ) : (
          picker
        )}
      </I18nextProvider>,
    );
  });
}

function trigger() {
  const button = document.querySelector<HTMLButtonElement>(
    '[aria-haspopup="menu"]',
  );
  if (!button) throw new Error('Missing picker trigger');
  return button;
}

function menu() {
  return document.querySelector<HTMLDivElement>('[role="menu"]');
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('Missing test element or fixture');
  return value;
}

function row(title: string) {
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.textContent?.includes(title));
  if (!item) throw new Error(`Missing menu item: ${title}`);
  return item;
}

async function openMenu() {
  await act(async () => {
    trigger().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function key(target: Element | null, value: string) {
  await act(async () => {
    required(target).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('InkAgentDestinationPicker', () => {
  it('shows unresolved conversation choice without implying a new conversation', async () => {
    await render({ binding: null, unresolved: true });
    expect(trigger().textContent).toBe('Choose conversation');
    await openMenu();
    expect(menu()?.querySelector('[role="menuitem"].text-info')).toBeNull();
    expect(row('First review').disabled).toBe(false);
    await render({ loading: true });
    expect(trigger().textContent).toBe('Loading conversation…');
  });

  it('requires an explicit choice when no binding exists and refreshes only on opening', async () => {
    await render({ binding: null, conversations: [] });
    expect(trigger().textContent).toBe('Choose an Agent');
    expect(props.onRefreshProfiles).not.toHaveBeenCalled();
    expect(props.onNewConversation).not.toHaveBeenCalled();
    await openMenu();
    expect(props.onRefreshProfiles).toHaveBeenCalledOnce();
    expect(menu()?.textContent).not.toContain('No conversations to continue');
    expect(menu()?.textContent).not.toContain('Continue conversation');
    expect(menu()?.querySelector('[role="menuitem"].text-info')).toBeNull();
    expect(menu()?.querySelectorAll('[role="group"]')).toHaveLength(1);
    await render({ profiles: [...profiles] });
    expect(props.onRefreshProfiles).toHaveBeenCalledOnce();
    await act(async () => trigger().click());
    expect(menu()).toBeNull();
    await openMenu();
    expect(props.onRefreshProfiles).toHaveBeenCalledTimes(2);
    expect(props.onNewConversation).not.toHaveBeenCalled();
    expect(props.onContinueConversation).not.toHaveBeenCalled();
  });

  it('reuses shared new-Agent choices and reports the choice without mutating controlled state', async () => {
    await render({ binding: null });
    await openMenu();
    await act(async () => row('Reviewer').click());
    expect(props.onNewConversation).toHaveBeenCalledExactlyOnceWith({
      mode: 'operate',
      binding: { kind: 'external', profileId: 'reviewer', alias: 'Reviewer' },
    });

    expect(props.onContinueConversation).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(trigger().textContent).toBe('Choose an Agent');
    await render({ binding });
    expect(trigger().textContent).toContain('ReviewerNew');
  });

  it('retains an all-busy continuation group and hides it only after its last conversation is removed', async () => {
    await render({ conversations: [required(conversations[1])] });
    await openMenu();
    expect(menu()?.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(row('Busy review').disabled).toBe(true);
    await render({ conversations: [] });
    expect(menu()?.querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(menu()?.textContent).not.toContain('Busy review');
    await render({ conversations });
    expect(menu()?.querySelectorAll('[role="group"]')).toHaveLength(2);
  });

  it('distinguishes conversations sharing one Profile and retains the selected title and Agent identity', async () => {
    await render({ selectedNodeId: 'first' });
    expect(trigger().textContent).toContain('First reviewContinue');
    expect(trigger().getAttribute('aria-label')).toContain('Reviewer');
    await openMenu();
    expect(row('First review').textContent).toContain('Reviewer');
    expect(row('Second review').textContent).toContain('Reviewer');
    expect(row('First review').getAttribute('aria-current')).toBe('true');
    await act(async () => row('Second review').click());
    expect(props.onContinueConversation).toHaveBeenCalledExactlyOnceWith(
      'second',
    );
    expect(props.onNewConversation).not.toHaveBeenCalled();
    expect(trigger().textContent).toContain('First reviewContinue');
    await render({ selectedNodeId: 'second' });
    expect(trigger().textContent).toContain('Second reviewContinue');
  });

  it('keeps unavailable conversations visible, explains their status, and responds to availability changes', async () => {
    await render({ selectedNodeId: 'busy' });
    expect(trigger().textContent).toContain('Busy reviewContinue');
    expect(trigger().disabled).toBe(false);
    expect(
      document.getElementById(
        required(trigger().getAttribute('aria-describedby')),
      )?.textContent,
    ).toBe('Running');
    await openMenu();
    expect(row('Busy review').disabled).toBe(true);
    expect(row('Busy review').textContent).toContain('Running');
    expect(row('Reviewer').disabled).toBe(false);
    await act(async () => row('Busy review').click());
    expect(props.onContinueConversation).not.toHaveBeenCalled();
    await render({
      conversations: conversations.map((conversation) => ({
        ...conversation,
        disabledReason: undefined,
      })),
    });
    expect(row('Busy review').disabled).toBe(false);
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
    await act(async () => row('Busy review').click());
    expect(props.onContinueConversation).toHaveBeenCalledWith('busy');
  });

  it('does not silently turn a disappeared continuation into a new conversation', async () => {
    await render({
      selectedNodeId: 'gone',
      unavailableReason: 'The destination was removed',
    });
    expect(trigger().textContent).toContain('Conversation unavailableContinue');
    await openMenu();
    expect(menu()?.textContent).toContain('The destination was removed');
    expect(props.onNewConversation).not.toHaveBeenCalled();
    expect(props.onContinueConversation).not.toHaveBeenCalled();
    expect(row('Second review').disabled).toBe(false);
  });

  it('uses bind-time avatar snapshots and aliases when a conversation Profile is missing', async () => {
    const fallbackIcon = { shape: 'circle', color: 'blue' } as const;
    await render({
      profiles: [],
      selectedNodeId: 'first',
      conversations: [{ ...required(conversations[0]), fallbackIcon }],
    });
    expect(trigger().getAttribute('aria-label')).toContain('Old alias');
    expect(
      JSON.parse(
        required(
          trigger().querySelector('[data-avatar]')?.getAttribute('data-avatar'),
        ),
      ),
    ).toEqual({ kind: 'external', alias: 'Old alias', icon: fallbackIcon });
  });

  it('disables the trigger and all already-open choices during a caller-owned lock', async () => {
    await render({ disabled: true });
    await openMenu();
    expect(menu()).toBeNull();
    expect(props.onRefreshProfiles).not.toHaveBeenCalled();
    await render({ disabled: false });
    await openMenu();
    await render({ disabled: true });
    const items = [
      ...required(menu()).querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    ];
    expect(items.every((item) => item.disabled)).toBe(true);
    await act(async () => items.forEach((item) => item.click()));
    expect(props.onContinueConversation).not.toHaveBeenCalled();
    expect(props.onNewConversation).not.toHaveBeenCalled();
  });

  it('supports keyboard opening, roving focus, disabled-row skipping, Escape and Tab dismissal', async () => {
    await render();
    trigger().focus();
    await key(trigger(), 'ArrowDown');
    expect(document.activeElement).toBe(
      menu()?.querySelector('[role="menuitem"]'),
    );
    await key(document.activeElement, 'End');
    expect(document.activeElement).toBe(row('Second review'));
    await key(document.activeElement, 'ArrowUp');
    expect(document.activeElement).toBe(row('First review'));
    await key(document.activeElement, 'ArrowDown');
    expect(document.activeElement).toBe(row('Second review'));
    await key(document.activeElement, 'Home');
    expect(document.activeElement).toBe(
      menu()?.querySelector('[role="menuitem"]'),
    );
    await key(document.activeElement, 'Escape');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await key(trigger(), 'ArrowUp');
    expect(document.activeElement).toBe(row('Second review'));
    await key(document.activeElement, 'Tab');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('preserves pointer selection, marks portalled chrome, and does not cancel touch activation', async () => {
    await render();
    const mouseDown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    const touchDown = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
    });
    await act(async () => {
      trigger().dispatchEvent(mouseDown);
      trigger().dispatchEvent(touchDown);
    });
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(touchDown.defaultPrevented).toBe(false);
    expect(ancestorPointer).not.toHaveBeenCalled();
    await openMenu();
    expect(ancestorClick).not.toHaveBeenCalled();
    expect(menu()?.closest('[data-floating-chrome]')).not.toBeNull();
    expect(menu()?.className).toContain('overflow-y-auto');
    expect(menu()?.parentElement?.className).toContain('max-w-');
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
    expect(props.onNewConversation).not.toHaveBeenCalled();
  });

  it('clamps a tall menu within a short viewport and keeps its parent portal and empty selection', async () => {
    vi.stubGlobal('innerWidth', 320);
    vi.stubGlobal('innerHeight', 240);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('w-80')) {
          return new DOMRect(0, 0, 296, 180);
        }
        return new DOMRect(250, 100, 40, 32);
      },
    );
    await render({ binding: null }, true);
    await openMenu();
    const panel = required(menu()?.parentElement);
    expect(panel.closest('.picker-test-parent')).not.toBeNull();
    const x = Number.parseFloat(panel.style.left);
    const y = Number.parseFloat(panel.style.top);
    expect(x).toBeGreaterThanOrEqual(12);
    expect(x + 296).toBeLessThanOrEqual(308);
    expect(y).toBeGreaterThanOrEqual(12);
    expect(y + 180).toBeLessThanOrEqual(228);
    expect(menu()?.className).toContain('100dvh-40px');
    expect(menu()?.className).toContain('overflow-y-auto');
    expect(menu()?.className).toContain('overscroll-contain');
    expect(menu()?.querySelector('[aria-current]')).toBeNull();
    expect(menu()?.querySelector('[role="menuitem"].text-info')).toBeNull();
    await act(async () => row('Second review').click());
    expect(props.onContinueConversation).toHaveBeenCalledWith('second');
    expect(document.querySelector('.picker-test-parent')).not.toBeNull();
  });

  it('provides matching localized picker keys and renders Chinese labels', async () => {
    expect(Object.keys(en.toolbar.inkAgentPicker).sort()).toEqual(
      Object.keys(zh.toolbar.inkAgentPicker).sort(),
    );
    await i18n.changeLanguage('zh-CN');
    await render({ binding: null, conversations: [] });
    expect(trigger().textContent).toBe('选择 Agent');
    await openMenu();
    expect(menu()?.textContent).toContain('新建会话');
    expect(menu()?.textContent).not.toContain('继续会话 · 当前画布');
    expect(menu()?.textContent).not.toContain('当前画布暂无可继续的会话');
    await render({ conversations });
    expect(menu()?.textContent).toContain('继续会话 · 当前画布');
  });
});
