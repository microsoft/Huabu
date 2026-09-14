// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

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
