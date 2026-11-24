// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { SessionUsage, type SessionUsageProps } from './SessionUsage';

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: SessionUsageProps) {
  await act(async () => root.render(<SessionUsage {...props} />));
}

async function open() {
  const trigger = container.querySelector('button');
  assert(trigger);
  await act(async () => trigger.click());
  const panel = document.querySelector<HTMLElement>('[role="region"]');
  assert(panel);
  return panel;
}

describe('SessionUsage', () => {
  it('keeps the entry visible without data and never invents usage', async () => {
    await render({ usage: null, tokenUsage: null });
    expect(container.textContent).toBe('Session usage');
    const panel = await open();
    expect(panel.textContent?.match(/Not reported/g)).toHaveLength(4);
    expect(panel.textContent).toContain('Reported by the Agent via ACP');
    expect(panel.textContent).not.toContain('0 tokens');
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('button'));
  });

  it('shows context without cost, and tokens without a context report', async () => {
    await render({
      usage: { used: 0, size: 128000, cost: null, receivedAt: 1000 },
      tokenUsage: null,
    });
    const panel = await open();
    expect(panel.textContent).toContain('0 / 128,000 tokens');
    expect(panel.textContent).toContain('Last received:');
    await render({
      usage: null,
      tokenUsage: {
        inputTokens: 3004,
        outputTokens: 74,
        totalTokens: 3078,
        receivedAt: 2000,
      },
    });
    expect(panel.textContent).toContain('3,004 tokens');
    expect(panel.textContent).toContain('74 tokens');
    expect(panel.textContent).not.toContain('128,000');
  });

  it('renders reported zero cost and its unit independently of an invalid window', async () => {
    await render({
      usage: { used: 10, size: 0, cost: { amount: 0, currency: 'credits' } },
      tokenUsage: null,
    });
    const panel = await open();
    expect(panel.textContent).toContain('0 credits');
    expect(panel.textContent).not.toContain('$');
    expect(panel.textContent).toContain('receipt time unavailable');
    expect(panel.textContent).not.toContain('10 / 0');
  });

  it('rejects invalid numbers and preserves precise small costs', async () => {
    await render({
      usage: { used: -1, size: 1000, cost: { amount: -2, currency: 'EUR' } },
      tokenUsage: {
        inputTokens: Infinity,
        outputTokens: 0,
        totalTokens: 0,
        receivedAt: NaN,
      },
    });
    const panel = await open();
    expect(panel.textContent).not.toMatch(/Infinity|NaN|-1|-2/);
    expect(panel.textContent).toContain('0 tokens');
    await render({
      usage: {
        used: 10,
        size: 1000,
        cost: { amount: 0.000001, currency: 'EUR' },
      },
      tokenUsage: null,
      unavailable: true,
    });
    expect(panel.textContent).toContain('0.000001 EUR');
    expect(panel.textContent).toContain('could not be refreshed');
  });
});
