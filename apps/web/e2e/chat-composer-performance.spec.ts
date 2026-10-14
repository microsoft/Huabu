// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as ChatStoreModule from '../src/store/chatStore';

type InputMode = 'direct' | 'composition';

async function measureInputToPaint(page: Page, mode: InputMode) {
  return page
    .locator('textarea[name="agent-message"]')
    .evaluate(async (textarea, inputMode) => {
      const input = textarea as HTMLTextAreaElement;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!valueSetter) throw new Error('textarea value setter unavailable');

      const samples: number[] = [];
      for (let index = 0; index < 12; index++) {
        const nextCharacter = inputMode === 'composition' ? '你' : 'a';
        const duration = await new Promise<number>((resolve) => {
          const start = performance.now();
          if (inputMode === 'composition') {
            input.dispatchEvent(
              new CompositionEvent('compositionstart', { bubbles: true }),
            );
          }
          valueSetter.call(input, input.value + nextCharacter);
          input.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: nextCharacter,
              inputType:
                inputMode === 'composition'
                  ? 'insertCompositionText'
                  : 'insertText',
              isComposing: inputMode === 'composition',
            }),
          );
          if (inputMode === 'composition') {
            input.dispatchEvent(
              new CompositionEvent('compositionend', {
                bubbles: true,
                data: nextCharacter,
              }),
            );
          }
          requestAnimationFrame(() => resolve(performance.now() - start));
        });
        samples.push(duration);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }

      samples.sort((left, right) => left - right);
      return {
        median: samples[Math.floor(samples.length / 2)] ?? 0,
        p95: samples[Math.ceil(samples.length * 0.95) - 1] ?? 0,
      };
    }, mode);
}

async function openFixture(page: Page, messageCount: number) {
  await page.goto(`/playground/chat-performance?messages=${messageCount}`);
  await expect(
    page.locator(`[data-chat-performance-fixture="${messageCount}"]`),
  ).toBeVisible();
  await expect(page.locator('[data-chat-user-message]')).toHaveCount(
    Math.ceil(messageCount / 2),
  );
  await expect(page.locator('textarea[name="agent-message"]')).toBeEditable();
  await page.waitForTimeout(500);
}

test('recent-turn window keeps the initial DOM bounded', async ({ page }) => {
  await page.goto(
    '/playground/chat-performance?messages=200&visibleMessages=6',
  );
  await expect(
    page.locator('[data-chat-performance-fixture="200"]'),
  ).toHaveAttribute('data-chat-visible-messages', '6');
  await expect(page.locator('[data-chat-user-message]')).toHaveCount(3);
  await expect(
    page.locator('[data-chat-message-id^="assistant-"]'),
  ).toHaveCount(3);
});

test('input-to-paint remains stable with 200 historical messages', async ({
  page,
}) => {
  await openFixture(page, 0);
  const freshDirect = await measureInputToPaint(page, 'direct');
  await openFixture(page, 0);
  const freshComposition = await measureInputToPaint(page, 'composition');

  await openFixture(page, 200);
  const longDirect = await measureInputToPaint(page, 'direct');
  await openFixture(page, 200);
  const longComposition = await measureInputToPaint(page, 'composition');

  console.log({
    freshDirect,
    longDirect,
    freshComposition,
    longComposition,
  });

  expect(longDirect.p95 - freshDirect.p95).toBeLessThanOrEqual(8);
  expect(longComposition.p95 - freshComposition.p95).toBeLessThanOrEqual(8);
});

test('composer grows from two to ten lines and shrinks when the draft is cleared', async ({
  page,
}) => {
  await page.goto('/playground/chat-performance?messages=0');
  const input = page.locator('textarea[name="agent-message"]');
  const rows = () =>
    input.evaluate(
      (element) =>
        element.getBoundingClientRect().height /
        parseFloat(getComputedStyle(element).lineHeight),
    );
  await expect.poll(rows).toBe(2);
  for (const lines of [1, 2, 3, 9, 10, 11, 20]) {
    await input.fill(
      Array.from({ length: lines }, (_, index) => `Line ${index + 1}`).join(
        '\n',
      ),
    );
    await expect.poll(rows).toBe(Math.min(10, Math.max(2, lines)));
  }
  expect(
    await input.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await expect(input).toHaveCSS('overflow-y', 'auto');
  await input.fill('Short draft');
  await expect.poll(rows).toBe(2);
  await input.fill('');
  await expect.poll(rows).toBe(2);
});

test('composer remeasures wrapped text when its width changes and when drafts are restored', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/playground/chat-performance?messages=0');
  const input = page.locator('textarea[name="agent-message"]');
  const height = () =>
    input.evaluate((element) => element.getBoundingClientRect().height);
  await input.fill('Wrapped words '.repeat(30));
  const wideHeight = await height();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(height).toBeGreaterThan(wideHeight);
  expect(
    await input.evaluate(
      (element) =>
        element.getBoundingClientRect().height /
        parseFloat(getComputedStyle(element).lineHeight),
    ),
  ).toBeLessThanOrEqual(10);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(height).toBe(wideHeight);
  await input.fill('unbroken'.repeat(500));
  await expect
    .poll(() =>
      input.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    )
    .toBe(10);
  await page.evaluate(async () => {
    const storePath = '/src/store/chatStore.ts';
    const { useChatStore } = (await import(
      storePath
    )) as typeof ChatStoreModule;
    useChatStore
      .getState()
      .setDraft(
        'chat-performance-thread',
        Array.from(
          { length: 6 },
          (_, index) => `Restored line ${index + 1}`,
        ).join('\n'),
      );
  });
  await expect
    .poll(() =>
      input.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    )
    .toBe(6);
  await page.evaluate(async () => {
    const storePath = '/src/store/chatStore.ts';
    const { useChatStore } = (await import(
      storePath
    )) as typeof ChatStoreModule;
    useChatStore.getState().setDraft('chat-performance-thread', '');
  });
  await expect(input).toHaveValue('');
  await expect
    .poll(() =>
      input.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          parseFloat(getComputedStyle(element).lineHeight),
      ),
    )
    .toBe(2);
});
