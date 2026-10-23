// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import en from '@/i18n/resources/en/common.json';

import { SpaceAgentActivity } from './SpaceAgentActivity';

import type { SpaceAgentActivity as Activity } from '@huabu/shared';

const profiles = vi.hoisted(() => ({
  profiles: [
    {
      id: 'reviewer',
      alias: 'Current reviewer',
      customData: { icon: { shape: 'flower', color: 'green' } },
    },
  ],
  init: vi.fn(),
}));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (selector: (state: typeof profiles) => unknown) =>
    selector(profiles),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const i18n = createInstance();
let host: HTMLDivElement;
let root: Root;
const open = vi.fn();
const fit = vi.hoisted(() => ({ visibleCount: 3 }));
vi.mock('./useSpaceAgentFit', () => ({
  useSpaceAgentFit: () => ({
    rowRef: { current: null },
    probesRef: { current: null },
    visibleCount: fit.visibleCount,
  }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  fit.visibleCount = 3;
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function render(activity?: Activity, failed = false) {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <SpaceAgentActivity activity={activity} failed={failed} onOpen={open} />
      </I18nextProvider>,
    ),
  );
}

it('keeps sessions separate and resolves current or deleted Profile identity with status and title', () => {
  const activity: Activity = [
    {
      nodeId: 'node-1',
      threadId: 'one',
      title: 'First review',
      status: 'running',
      agentBinding: {
        kind: 'external',
        profileId: 'reviewer',
        alias: 'Old name',
      },
    },
    {
      nodeId: 'node-2',
      threadId: 'two',
      title: 'Second review',
      status: 'approval',
      agentBinding: {
        kind: 'external',
        profileId: 'reviewer',
        alias: 'Old name',
      },
    },
    {
      nodeId: 'node-3',
      threadId: 'three',
      title: 'Archived session',
      status: 'unread',
      agentBinding: {
        kind: 'external',
        profileId: 'deleted',
        alias: 'Deleted reviewer',
      },
      agentIcon: { shape: 'diamond', color: 'blue' },
    },
    { nodeId: 'node-4', threadId: 'four', title: null, status: 'unknown' },
  ];
  render(activity);
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    'button[data-space-agent-thread]',
  );
  expect(buttons).toHaveLength(3);
  expect(buttons[0].getAttribute('aria-label')).toBe(
    'Current reviewer · First review · Running — Open conversation',
  );
  expect(buttons[1].getAttribute('aria-label')).toBe(
    'Current reviewer · Second review · Approval needed — Open conversation',
  );
  expect(buttons[2].getAttribute('aria-label')).toContain(
    'Deleted reviewer · Archived session · To review',
  );
  expect(buttons[0].textContent).toBe('Running');
  expect(buttons[1].textContent).toBe('Approval needed');
  expect(buttons[2].textContent).toBe('To review');
  expect(
    host.querySelector('[aria-label="Show 1 more conversation"]')?.textContent,
  ).toBe('+1');
  expect(buttons[2].querySelector('.lucide')).toBeNull();
  expect(
    host.querySelector(
      '[data-question-takeover-avatar], .question-agent-ring-running, .question-agent-ring-approval, .question-agent-ring-error',
    ),
  ).toBeNull();
  act(() => buttons[1].click());
  expect(open).toHaveBeenCalledExactlyOnceWith(activity[1]);
  expect(profiles.init).toHaveBeenCalledOnce();
  render([activity[3]]);
  expect(host.querySelector('button')?.getAttribute('aria-label')).toContain(
    'Unknown Agent · Chat · Status unknown',
  );
  expect(host.querySelector('button')?.textContent).toBe('Status unknown');
});

it('hides idle sessions and follows measured capacity, including zero and more than three entries', () => {
  const activity: Activity = Array.from({ length: 30 }, (_, index) => ({
    nodeId: `node-${index}`,
    threadId: `thread-${index}`,
    title: `Session ${index}`,
    status: index < 2 ? 'idle' : 'error',
    agentBinding: { kind: 'internal' },
  }));
  render(activity);
  expect(host.querySelectorAll('[data-space-agent-thread]')).toHaveLength(3);
  expect(host.querySelector('[data-space-agent-thread="thread-0"]')).toBeNull();
  expect(
    Array.from(
      host.querySelectorAll('button'),
      (button) => button.textContent,
    ).join(''),
  ).toBe('Run errorRun errorRun error+25');
  expect(
    host.querySelector('[aria-label="Show 25 more conversations"]'),
  ).not.toBeNull();
  expect(activity).toHaveLength(30);
  fit.visibleCount = 0;
  render(activity);
  expect(host.querySelectorAll('[data-space-agent-thread]')).toHaveLength(0);
  expect(
    host.querySelector('[aria-label="Show 28 more conversations"]')
      ?.textContent,
  ).toBe('+28');
  fit.visibleCount = 5;
  render(activity);
  expect(host.querySelectorAll('[data-space-agent-thread]')).toHaveLength(5);
  expect(
    host.querySelector('[aria-label="Show 23 more conversations"]')
      ?.textContent,
  ).toBe('+23');
  render(activity.slice(0, 4));
  expect(host.querySelectorAll('[data-space-agent-thread]')).toHaveLength(2);
  expect(host.querySelector('[aria-haspopup]')).toBeNull();
  render(activity.slice(0, 2));
  expect(host.querySelector('[data-space-agent-activity]')).toBeNull();
  render(activity);
  render(activity, true);
  expect(host.textContent).toBe('Agent activity unavailable');
  expect(host.querySelector('button')).toBeNull();
});

it('distinguishes loading, failed and empty activity without stale conversation buttons', () => {
  render();
  expect(host.textContent).toBe('Loading Agent activity…');
  render([], true);
  expect(host.textContent).toBe('Agent activity unavailable');
  expect(host.querySelector('button')).toBeNull();
  render([]);
  expect(host.textContent).toBe('');
  expect(profiles.init).not.toHaveBeenCalled();
});

it.each([
  ['running', 'bg-info-bg'],
  ['approval', 'bg-warning-bg'],
  ['error', 'bg-danger-bg'],
  ['unread', 'bg-success-bg'],
  ['unknown', 'bg-hover'],
] as const)(
  'groups the avatar and %s label in one badge with matching measurement padding',
  (status, background) => {
    render([{ nodeId: 'node-1', threadId: 'one', title: 'Review', status }]);
    const badge = host.querySelector<HTMLElement>('[data-space-agent-badge]');
    const probe = host.querySelector<HTMLElement>('[data-agent-fit-status]');
    expect(badge?.classList.contains(background)).toBe(true);
    expect(badge?.querySelector('svg')).not.toBeNull();
    expect(badge?.textContent).toBe(
      i18n.t(
        status === 'unknown'
          ? 'spacePreview.sessionStatus.unknown'
          : `node.questionCard.${status}`,
      ),
    );
    for (const className of ['gap-1.5', 'rounded-md', 'py-[3px]']) {
      expect(badge?.classList.contains(className)).toBe(true);
      expect(probe?.classList.contains(className)).toBe(true);
    }
    expect(badge?.style.paddingInline).toBe('6px');
    expect(probe?.style.paddingInline).toBe('6px');
    expect(badge?.querySelector('span.size-6')).not.toBeNull();
    expect(probe?.querySelector('span.size-6')).not.toBeNull();
    expect(
      host.querySelector<HTMLElement>('[data-space-agent-activity]')?.style
        .marginLeft,
    ).toBe('');
  },
);
