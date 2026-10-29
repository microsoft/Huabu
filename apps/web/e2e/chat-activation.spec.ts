// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

const panel = (page: Page, id = 'a') =>
  page.locator(`[data-activation-panel="${id}"]`);
const scroll = (page: Page) => page.locator('[data-chat-thread-root]:visible');
async function settle(page: Page) {
  await page.waitForTimeout(400);
}
async function anchor(page: Page) {
  return scroll(page).evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [
      ...element.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
    ].find((item) => item.getBoundingClientRect().bottom > top + 1);
    if (!row?.dataset.chatMessageId) throw new Error('No reading anchor');
    return {
      id: row.dataset.chatMessageId,
      offset: row.getBoundingClientRect().top - top,
    };
  });
}
async function drift(page: Page, saved: { id: string; offset: number }) {
  return scroll(page).evaluate((element, previous) => {
    const row = [
      ...element.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
    ].find((item) => item.dataset.chatMessageId === previous.id);
    return row
      ? Math.abs(
          row.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            previous.offset,
        )
      : Infinity;
  }, saved);
}
async function go(page: Page, ratio: number) {
  await scroll(page).evaluate((element, fraction) => {
    const target = (element.scrollHeight - element.clientHeight) * fraction;
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        deltaY: target > element.scrollTop ? 100 : -100,
      }),
    );
    element.scrollTop = target;
  }, ratio);
  await settle(page);
}
async function open(page: Page) {
  await page.goto('/playground/chat-performance?mode=activation&turns=100');
  await expect(panel(page)).toBeVisible();
  await expect(
    panel(page).locator('[data-chat-message-id="a-turn-100-answer"] h3'),
  ).toBeVisible();
  await settle(page);
}
test.beforeEach(async ({ page }, info) => {
  test.skip(
    info.config.metadata.chatActivationProduction !== true,
    'Requires production activation config',
  );
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'fixture_offline', message: 'No backend in fixture' },
      }),
    }),
  );
});

for (const width of [1280, 390]) {
  test(`compact return control stays stable while scrolling at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    const button = panel(page).getByRole('button', {
      name: 'Back to bottom',
      exact: true,
    });
    const move = async (gap: number) => {
      await scroll(page).evaluate((element, distance) => {
        element.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
        );
        element.scrollTop =
          element.scrollHeight - element.clientHeight - distance;
      }, gap);
      await settle(page);
    };
    await expect(button).toHaveCount(0);
    await move(100);
    await expect(button).toHaveCount(0);
    await move(200);
    await expect(button).toBeVisible();
    await expect(button).toHaveText('');
    const bounds = await button.boundingBox();
    expect(bounds?.width).toBe(32);
    expect(bounds?.height).toBe(32);
    for (const gap of [150, 100, 60]) {
      await move(gap);
      await expect(button).toBeVisible();
      expect(await button.boundingBox()).toEqual(bounds);
    }
    await move(40);
    await expect(button).toHaveCount(0);
    await move(100);
    await expect(button).toHaveCount(0);
    await go(page, 0.4);
    await page.screenshot({ path: info.outputPath('return-arrow.png') });
    await button.focus();
    await button.press('Enter');
    await settle(page);
    await expect(button).toHaveCount(0);
    await go(page, 0.4);
    await page.getByRole('button', { name: 'Start turn', exact: true }).click();
    const newMessage = panel(page).getByRole('button', {
      name: 'New message',
      exact: true,
    });
    await expect(newMessage).toBeVisible();
    await expect(newMessage).toHaveText('New message');
    await expect(newMessage.locator('svg')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: info.outputPath('return-new-message.png') });
    await newMessage.click();
    await settle(page);
    expect(
      await scroll(page).evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    ).toBeLessThanOrEqual(2);
    await expect(newMessage).toHaveCount(0);
  });
}

test('bounded rich DOM, history stays still and explicit latest resumes following', async ({
  page,
}) => {
  await open(page);
  expect(
    await scroll(page).evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
  ).toBeLessThanOrEqual(2);
  expect(
    await panel(page).locator('[data-chat-message-id]').count(),
  ).toBeLessThan(30);
  await go(page, 0.4);
  const saved = await anchor(page);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'New message', exact: true }).click();
  await settle(page);
  await page
    .getByRole('button', { name: 'Complete turn', exact: true })
    .click();
  await settle(page);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  await settle(page);
  expect(
    await scroll(page).evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
  ).toBeLessThanOrEqual(2);
});

test('sending at bottom follows streamed growth until upward scrolling, then resumes explicitly', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  await settle(page);
  await page
    .getByRole('button', { name: 'Append output', exact: true })
    .click();
  await settle(page);
  expect(
    await scroll(page).evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
  ).toBeLessThanOrEqual(2);
  await go(page, 0.6);
  const saved = await anchor(page);
  await page
    .getByRole('button', { name: 'Append output', exact: true })
    .click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'New message', exact: true }).click();
  await settle(page);
  await page
    .getByRole('button', { name: 'Append output', exact: true })
    .click();
  await settle(page);
  expect(
    await scroll(page).evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
  ).toBeLessThanOrEqual(2);
});

for (const submit of ['button', 'enter'] as const) {
  test(`sending a multiline draft via ${submit} follows to the bottom`, async ({
    page,
  }) => {
    await open(page);
    const input = panel(page).locator('textarea');
    await input.fill('A long draft line.\n'.repeat(12));
    await settle(page);
    if (submit === 'button')
      await panel(page)
        .getByRole('button', { name: 'Send', exact: true })
        .click();
    else await input.press('Enter');
    await settle(page);
    expect(
      await scroll(page).evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    ).toBeLessThanOrEqual(2);
    await page
      .getByRole('button', { name: 'Append output', exact: true })
      .click();
    await settle(page);
    expect(
      await scroll(page).evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    ).toBeLessThanOrEqual(2);
  });
}

test('composing and sending a multiline draft while reading history preserves its anchor', async ({
  page,
}) => {
  await open(page);
  await go(page, 0.4);
  const saved = await anchor(page);
  await panel(page).locator('textarea').fill('A long draft line.\n'.repeat(12));
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
  await panel(page).getByRole('button', { name: 'Send', exact: true }).click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
  await page
    .getByRole('button', { name: 'Append output', exact: true })
    .click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
});

test('returning to a following tab restores its bookmark instead of following background output', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  await settle(page);
  const saved = await anchor(page);
  await page.getByRole('button', { name: 'Tab B', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add background turn to A', exact: true })
    .click();
  await page.getByRole('button', { name: 'Tab A', exact: true }).click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
});

for (const remount of [false, true]) {
  test(`restores reading after ${remount ? 'LRU eviction' : 'retained Activity'} and background output`, async ({
    page,
  }) => {
    await open(page);
    await go(page, 0.4);
    const saved = await anchor(page);
    await page.getByRole('button', { name: 'Tab B', exact: true }).click();
    if (remount)
      await page.getByRole('button', { name: 'Tab C', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add background turn to A', exact: true })
      .click();
    await page.getByRole('button', { name: 'Tab A', exact: true }).click();
    await settle(page);
    expect(await drift(page, saved)).toBeLessThanOrEqual(2);
    await expect(
      page.getByRole('button', {
        name: 'Back to last reading position',
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

test('late image above the reading anchor does not move the reader', async ({
  page,
}) => {
  await open(page);
  await go(page, 0.4);
  const saved = await anchor(page);
  await scroll(page).evaluate((element, id) => {
    const rows = [
      ...element.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
    ];
    const index = rows.findIndex((row) => row.dataset.chatMessageId === id);
    const previous = rows[index - 1];
    if (!previous) throw new Error('No overscan row above the anchor');
    const image = document.createElement('div');
    image.style.height = '900px';
    previous.append(image);
  }, saved.id);
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
});

test('narrow chat stays inside viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const sizes = await scroll(page).evaluate((element) => ({
    width: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.width);
  await page.screenshot({
    path: 'test-results/chat-activation/manual-chat-narrow.png',
  });
});

for (const gesture of ['scrollbar', 'wheel'] as const) {
  test(`large ${gesture} jumps hold a stable loading surface until rich rows settle`, async ({
    page,
  }) => {
    await open(page);
    const samples = await scroll(page).evaluate(async (element, gesture) => {
      if (gesture === 'scrollbar')
        element.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            clientX: element.getBoundingClientRect().right - 1,
          }),
        );
      const samples: Array<{ loading: boolean; placeholders: number }> = [];
      for (let step = 0; step < 36; step++) {
        if (gesture === 'wheel')
          element.dispatchEvent(
            new WheelEvent('wheel', { bubbles: true, deltaY: -900 }),
          );
        element.scrollTop =
          (element.scrollHeight - element.clientHeight) * (0.85 - step * 0.015);
        await new Promise((resolve) => setTimeout(resolve, 25));
        samples.push({
          loading: !!element.parentElement?.querySelector(
            '[data-chat-scroll-loading]',
          ),
          placeholders: element.querySelectorAll('[data-chat-seek-placeholder]')
            .length,
        });
      }
      window.dispatchEvent(new PointerEvent('pointerup'));
      return samples;
    }, gesture);
    const firstLoading = samples.findIndex((sample) => sample.loading);
    expect(firstLoading).toBeGreaterThanOrEqual(0);
    expect(samples.slice(firstLoading).every((sample) => sample.loading)).toBe(
      true,
    );
    expect(samples.some((sample) => sample.placeholders > 0)).toBe(true);
    await expect(page.locator('[data-chat-scroll-loading]')).toHaveCount(0);
    await expect(
      scroll(page).locator('[data-chat-seek-placeholder]'),
    ).toHaveCount(0);
    const saved = await anchor(page);
    await settle(page);
    expect(await drift(page, saved)).toBeLessThanOrEqual(2);
  });
}

test('ordinary fast wheel scrolling uses row placeholders without a full loading surface', async ({
  page,
}) => {
  await open(page);
  const scrolling = scroll(page).evaluate(async (element) => {
    const samples: Array<{
      overlay: boolean;
      placeholders: number;
      indicators: number;
    }> = [];
    for (let step = 0; step < 36; step++) {
      element.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -300 }),
      );
      element.scrollTop -= 300;
      await new Promise((resolve) => setTimeout(resolve, 25));
      samples.push({
        overlay: !!element.querySelector('[data-chat-scroll-loading]'),
        placeholders: element.querySelectorAll('[data-chat-seek-placeholder]')
          .length,
        indicators: element.querySelectorAll('[data-loading-spinner]').length,
      });
    }
    return samples;
  });
  await expect
    .poll(() => scroll(page).locator('[data-chat-seek-placeholder]').count())
    .toBeGreaterThan(0);
  expect(
    await scroll(page)
      .locator('[data-chat-seek-placeholder] .skeleton-line')
      .evaluateAll((lines) =>
        lines.every((line) => getComputedStyle(line).animationName === 'none'),
      ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/chat-activation/ordinary-scroll-placeholders.png',
  });
  const samples = await scrolling;
  expect(samples.every((sample) => !sample.overlay)).toBe(true);
  expect(
    samples.some(
      (sample) => sample.placeholders > 1 && sample.indicators === 1,
    ),
  ).toBe(true);
  expect(samples.every((sample) => sample.indicators <= 1)).toBe(true);
  await expect(
    scroll(page).locator('[data-chat-seek-placeholder]'),
  ).toHaveCount(0);
  await expect(
    scroll(page).locator('[data-chat-loading-indicator]'),
  ).toHaveCount(0);
  const saved = await anchor(page);
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
});

test('streamed long answers keep the reader still and restore within a tall message', async ({
  page,
}) => {
  await open(page);
  const saved = await anchor(page);
  await page
    .getByRole('button', { name: 'Append output', exact: true })
    .click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
  await go(page, 1);
  // Read inside the tall answer, not at the scroll limit where a shorter
  // remounted layout must clamp the offset.
  await scroll(page).evaluate((element) => {
    element.scrollTop -= 100;
  });
  await settle(page);
  const inside = await anchor(page);
  expect(inside.offset).toBeLessThan(-500);
  await page.getByRole('button', { name: 'Tab B', exact: true }).click();
  await page.getByRole('button', { name: 'Tab C', exact: true }).click();
  await page.getByRole('button', { name: 'Tab A', exact: true }).click();
  await settle(page);
  expect(await drift(page, inside)).toBeLessThanOrEqual(2);
});

test('restores a message offset when a hidden tab returns at a different width', async ({
  page,
}) => {
  await open(page);
  await go(page, 0.4);
  const saved = await anchor(page);
  await page.getByRole('button', { name: 'Tab B', exact: true }).click();
  await page.setViewportSize({ width: 650, height: 800 });
  await page.getByRole('button', { name: 'Tab A', exact: true }).click();
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
});

const historyAnswer = (turn: number) =>
  `## Answer ${turn}\n\n${'A paragraph of readable history.\n\n'.repeat(8)}`;

async function mockHistory(
  page: Page,
  failure?: { nextOlder?: boolean; delayMs?: number },
) {
  const requests: string[] = [];
  await page.route('**/api/agent/history/*/page?*', async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get('before');
    requests.push(before ?? 'latest');
    if (failure?.delayMs)
      await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
    if (before && failure?.nextOlder) {
      failure.nextOlder = false;
      await route.fulfill({
        status: 503,
        json: {
          code: 'offline',
          message: 'History temporarily unavailable',
        },
      });
      return;
    }
    const end = before ? Number(before) : 60;
    const start = Math.max(0, end - Number(url.searchParams.get('limit')));
    await route.fulfill({
      json: {
        threadId: 'chat-performance-thread',
        turns: Array.from({ length: end - start }, (_, index) => {
          const turn = start + index;
          return {
            id: `turn-${turn}`,
            messages: [
              { role: 'user', content: `Question ${turn}` },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: historyAnswer(turn) }],
              },
            ],
          };
        }),
        before: start ? String(start) : undefined,
        hasMore: start > 0,
      },
    });
  });
  return requests;
}

test('automatically pages, evicts bodies and refetches using retained cursors', async ({
  page,
}) => {
  const requests = await mockHistory(page);
  await page.goto('/playground/chat-performance?mode=history');
  const fixture = page.locator('[data-chat-history-fixture]');
  await expect(fixture).toHaveAttribute('data-pages', '1');
  await settle(page);
  await expect(fixture).toHaveAttribute('data-pages', '1');
  expect(requests).toHaveLength(1);
  for (let count = 2; count <= 9; count++) {
    await go(page, 0);
    await expect
      .poll(async () => Number(await fixture.getAttribute('data-pages')))
      .toBeGreaterThanOrEqual(count);
  }
  await settle(page);
  expect(
    Number(await fixture.getAttribute('data-loaded-pages')),
  ).toBeLessThanOrEqual(5);
  expect(Number(await fixture.getAttribute('data-cached'))).toBeLessThanOrEqual(
    30,
  );
  const beforeCount = requests.length;
  await go(page, 0.6);
  await expect.poll(() => requests.length).toBeGreaterThan(beforeCount);
  expect(new Set(requests).size).toBeLessThan(requests.length);
  await expect(scroll(page).locator('[aria-busy=true]')).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`slow evicted-page refill stays behind loading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const network = { delayMs: 0 };
    await mockHistory(page, network);
    await page.goto('/playground/chat-performance?mode=history');
    const fixture = page.locator('[data-chat-history-fixture]');
    await expect(fixture).toHaveAttribute('data-pages', '1');
    await settle(page);
    await scroll(page).evaluate((element) =>
      element.dispatchEvent(new Event('chat-find-open')),
    );
    await expect(scroll(page).locator('[data-chat-message-id]')).toHaveCount(
      120,
    );
    await scroll(page).evaluate((element) =>
      element.dispatchEvent(new Event('chat-find-close')),
    );
    await settle(page);
    network.delayMs = 800;
    await scroll(page).evaluate(async (element) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: element.getBoundingClientRect().right - 1,
        }),
      );
      for (let step = 0; step < 24; step++) {
        element.scrollTop =
          (element.scrollHeight - element.clientHeight) * (0.8 - step * 0.015);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      window.dispatchEvent(new PointerEvent('pointerup'));
    });
    const loading = page.locator('[data-chat-scroll-loading]');
    await expect(loading).toBeVisible();
    await page.waitForTimeout(300);
    await expect(loading).toBeVisible();
    await expect(scroll(page).locator('[data-loading-spinner]')).toHaveCount(1);
    const scrollbar = await scroll(page).evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const trackHeight = element.clientHeight - 16;
      const thumbHeight = Math.max(
        24,
        (trackHeight * element.clientHeight) / element.scrollHeight,
      );
      const overlay = document
        .querySelector('[data-chat-scroll-loading]')
        ?.getBoundingClientRect();
      return {
        gutter: element.offsetWidth - element.clientWidth,
        contentRight: bounds.left + element.clientLeft + element.clientWidth,
        overlayRight: overlay?.right,
        overlayTop: overlay?.top,
        viewportTop: bounds.top + element.clientTop,
        overlayHeight: overlay?.height,
        viewportHeight: element.clientHeight,
        thumbColor: getComputedStyle(element, '::-webkit-scrollbar-thumb')
          .backgroundColor,
        scrollTop: element.scrollTop,
        thumbX: bounds.right - 4,
        thumbY:
          bounds.top +
          8 +
          ((trackHeight - thumbHeight) * element.scrollTop) /
            (element.scrollHeight - element.clientHeight) +
          thumbHeight / 2,
      };
    });
    expect(scrollbar.gutter).toBeGreaterThan(0);
    expect(scrollbar.overlayRight).toBeLessThanOrEqual(scrollbar.contentRight);
    expect(scrollbar.overlayTop).toBeCloseTo(scrollbar.viewportTop, 0);
    expect(scrollbar.overlayHeight).toBe(scrollbar.viewportHeight);
    expect(scrollbar.thumbColor).not.toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({
      path: `test-results/chat-activation/scroll-loading-${width}.png`,
    });
    await page.mouse.move(scrollbar.thumbX, scrollbar.thumbY);
    await page.mouse.down();
    await page.mouse.move(scrollbar.thumbX, scrollbar.thumbY + 60, {
      steps: 5,
    });
    await expect
      .poll(() => scroll(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollbar.scrollTop + 100);
    await page.mouse.up();
    await expect(loading).toHaveCount(0);
    await expect(scroll(page).locator('[aria-busy=true]')).toHaveCount(0);
    const saved = await anchor(page);
    await settle(page);
    expect(await drift(page, saved)).toBeLessThanOrEqual(2);
    expect(
      Number(await fixture.getAttribute('data-loaded-pages')),
    ).toBeLessThanOrEqual(5);
  });
}

test('source-addressed search traverses history with bounded residency', async ({
  page,
}) => {
  await mockHistory(page);
  await page.goto('/playground/chat-performance?mode=history');
  const fixture = page.locator('[data-chat-history-fixture]');
  await expect(fixture).toHaveAttribute('data-pages', '1');
  await settle(page);
  await scroll(page).evaluate(async (element, text) => {
    const bytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    );
    const hash = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    element.dispatchEvent(
      new CustomEvent('chat-reveal-search', {
        cancelable: true,
        detail: { source: { hash, offset: 3, length: 9 } },
      }),
    );
  }, historyAnswer(12));
  await expect(
    scroll(page).locator('[data-chat-message-id="turn-12:1"] h2'),
  ).toBeVisible();
  await scroll(page).evaluate((element) =>
    element.dispatchEvent(new Event('chat-search-finished')),
  );
  await settle(page);
  expect(
    Number(await fixture.getAttribute('data-loaded-pages')),
  ).toBeLessThanOrEqual(5);
  expect(
    await scroll(page).locator('[data-chat-message-id]').count(),
  ).toBeLessThan(30);
});

test('history failure waits for retry and prepend preserves the reading anchor', async ({
  page,
}) => {
  const requests = await mockHistory(page, { nextOlder: true });
  await page.goto('/playground/chat-performance?mode=history');
  await expect(page.locator('[data-chat-history-fixture]')).toHaveAttribute(
    'data-pages',
    '1',
  );
  await settle(page);
  await go(page, 0);
  await expect(page.getByRole('alert')).toContainText(
    'History temporarily unavailable',
  );
  const saved = await anchor(page);
  const count = requests.length;
  await settle(page);
  expect(requests).toHaveLength(count);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-chat-history-fixture]')).toHaveAttribute(
    'data-pages',
    '2',
  );
  await settle(page);
  expect(await drift(page, saved)).toBeLessThanOrEqual(2);
});

test('explicit local Find releases its full transcript when closed', async ({
  page,
}) => {
  await mockHistory(page);
  await page.goto('/playground/chat-performance?mode=history');
  const fixture = page.locator('[data-chat-history-fixture]');
  await expect(fixture).toHaveAttribute('data-pages', '1');
  await settle(page);
  await scroll(page).evaluate((element) =>
    element.dispatchEvent(new Event('chat-find-open')),
  );
  await expect(scroll(page).locator('[data-chat-message-id]')).toHaveCount(120);
  await scroll(page).evaluate((element) =>
    element.dispatchEvent(new Event('chat-find-close')),
  );
  await settle(page);
  expect(
    Number(await fixture.getAttribute('data-loaded-pages')),
  ).toBeLessThanOrEqual(5);
  expect(
    await scroll(page).locator('[data-chat-message-id]').count(),
  ).toBeLessThan(30);
});
