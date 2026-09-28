// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/resources/en/common.json';
import zhCN from '@/i18n/resources/zh-CN/common.json';

import { SpaceShortcutSummary } from './SpaceShortcutSummary';

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
function render(nodeCount?: number, updatedAt?: number, duplicate = false) {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <SpaceShortcutSummary nodeCount={nodeCount} updatedAt={updatedAt} />
        {duplicate ? (
          <SpaceShortcutSummary nodeCount={nodeCount} updatedAt={updatedAt} />
        ) : null}
      </I18nextProvider>,
    ),
  );
}

describe('Space Shortcut summary', () => {
  it('distinguishes unknown and empty counts and omits unknown timestamps', () => {
    render();
    expect(host.textContent).toBe('');
    render(0, 0);
    expect(host.textContent).toBe('No nodes');
    render(1);
    expect(host.textContent).toBe('1 node');
    render(24);
    expect(host.textContent).toBe('24 nodes');
  });

  it.each([
    [30_000, 'Updated now'],
    [120_000, 'Updated 2 minutes ago'],
    [7_200_000, 'Updated 2 hours ago'],
    [172_800_000, 'Updated 2 days ago'],
    [-60_000, 'Updated now'],
  ])(
    'formats elapsed time %s without displaying future ages',
    (elapsed, expected) => {
      render(24, time - elapsed);
      expect(host.textContent).toBe(`24 nodes · ${expected}`);
      expect(
        host
          .querySelector('[data-space-shortcut-summary]')
          ?.getAttribute('aria-label'),
      ).toContain(new Date(time - elapsed).toLocaleString('en'));
    },
  );

  it('updates relative ages with one shared timer and cleans it up on unmount', () => {
    render(24, time, true);
    expect(vi.getTimerCount()).toBe(1);
    expect(host.textContent).toContain('Updated now');
    act(() => vi.advanceTimersByTime(120_000));
    expect(host.textContent).toBe(
      '24 nodes · Updated 2 minutes ago24 nodes · Updated 2 minutes ago',
    );
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the active language for counts and relative time', async () => {
    await act(async () => i18n.changeLanguage('zh-CN'));
    render(24, time - 172_800_000);
    expect(host.textContent).toBe('24 个节点 · 2天前更新');
    render(0, time);
    expect(host.textContent).toBe('暂无节点 · 刚刚更新');
  });
});
