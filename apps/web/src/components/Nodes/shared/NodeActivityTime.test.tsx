// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SPACE_CARD_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import en from '@/i18n/resources/en/common.json';
import zhCN from '@/i18n/resources/zh-CN/common.json';

import { NodeActivityTime } from './NodeActivityTime';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const time = Date.UTC(2026, 8, 24, 4);
const i18n = createInstance();
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
  vi.useFakeTimers();
  vi.setSystemTime(time);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
function render(updatedAt?: number, duplicate = false) {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <NodeActivityTime updatedAt={updatedAt} />
        {duplicate ? <NodeActivityTime updatedAt={updatedAt} /> : null}
      </I18nextProvider>,
    ),
  );
}

describe('Space Shortcut summary', () => {
  it('omits unknown timestamps', () => {
    render();
    expect(host.textContent).toBe('');
    render(0);
    expect(host.textContent).toBe('');
    render(Infinity);
    expect(host.textContent).toBe('');
    render(1e30);
    expect(host.textContent).toBe('');
  });

  it('shares the timer with scaled conversation metadata and labels the activity honestly', () => {
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <NodeActivityTime updatedAt={time} />
          <NodeActivityTime updatedAt={time} kind="conversation" scale={1.5} />
        </I18nextProvider>,
      ),
    );
    expect(vi.getTimerCount()).toBe(1);
    const label = host.querySelector<HTMLElement>(
      '[data-conversation-activity-time]',
    );
    expect(label?.style.fontSize).toBe('27px');
    expect(label?.getAttribute('aria-label')).toContain(
      'Last conversation activity:',
    );
  });

  it.each([
    [30_000, 'now'],
    [120_000, '2m ago'],
    [7_200_000, '2h ago'],
    [172_800_000, '2d ago'],
    [-60_000, 'now'],
  ])(
    'formats elapsed time %s without displaying future ages',
    (elapsed, expected) => {
      render(time - elapsed);
      expect(host.textContent).toBe(expected);
      expect(
        host.querySelector<HTMLElement>('[data-space-shortcut-summary]')?.style
          .fontSize,
      ).toBe(`${SPACE_CARD_TYPOGRAPHY.metadata.size}px`);
      expect(
        host
          .querySelector('[data-space-shortcut-summary]')
          ?.getAttribute('aria-label'),
      ).toContain(new Date(time - elapsed).toLocaleString('en'));
    },
  );

  it('updates relative ages with one shared timer and cleans it up on unmount', () => {
    render(time, true);
    expect(vi.getTimerCount()).toBe(1);
    expect(host.textContent).toContain('now');
    act(() => vi.advanceTimersByTime(120_000));
    expect(host.textContent).toBe('2m ago2m ago');
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the active language for relative time', async () => {
    await act(async () => i18n.changeLanguage('zh-CN'));
    render(time - 172_800_000);
    expect(host.textContent).toBe('2天前');
    render(time);
    expect(host.textContent).toBe('刚刚');
  });
});
