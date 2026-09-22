// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { writeFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

// DOM snapshots distort repeated activation of the intentionally large control.
test.use({ trace: 'off' });

function panel(page: Page, id = 'a') {
  return page.locator(`[data-activation-panel="${id}"]`);
}

async function attribute(element: Locator, name: string) {
  const value = await element.getAttribute(name);
  if (value === null) throw new Error(`Missing fixture attribute: ${name}`);
  return value;
}

function messageIds(tab: string, first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) =>
    ['user', 'tool', 'answer'].map(
      (role) => `${tab}-turn-${first + index}-${role}`,
    ),
  ).flat();
}

async function expectTurns(
  page: Page,
  tab: string,
  first: number,
  last: number,
) {
  await expect
    .poll(() =>
      panel(page, tab)
        .locator('[data-chat-message-id]')
        .evaluateAll((elements) =>
          elements.map((element) =>
            element.getAttribute('data-chat-message-id'),
          ),
        ),
    )
    .toEqual(messageIds(tab, first, last));
}

type Presentation = 'windowed' | 'full-list';

async function openFixture(
  page: Page,
  turns = 12,
  presentation: Presentation = 'windowed',
) {
  await page.goto(
    `/playground/chat-performance?mode=activation&turns=${turns}&presentation=${presentation}`,
  );
  await expect(page.locator('[data-chat-activation-fixture]')).toHaveAttribute(
    'data-build-mode',
    'production',
  );
  await expect(page.locator('[data-chat-activation-fixture]')).toHaveAttribute(
    'data-presentation',
    presentation,
  );
  await expectTurns(
    page,
    'a',
    presentation === 'full-list' ? 1 : turns - 2,
    turns,
  );
  await expect(
    panel(page).locator('textarea[name="agent-message"]'),
  ).toBeEditable();
}

async function activate(page: Page, id: string) {
  await page
    .getByRole('button', { name: `Tab ${id.toUpperCase()}`, exact: true })
    .click();
  await expect(panel(page, id)).toBeVisible();
}

async function expand(page: Page) {
  await panel(page)
    .getByRole('button', { name: /Show \d+ earlier turns/i })
    .click();
}

async function scrollHistory(page: Page, bottom: boolean) {
  await panel(page)
    .locator('[data-chat-thread-root]')
    .evaluate(async (element, toBottom) => {
      // Match the wheel/scroll ownership path rather than merely assigning
      // scrollTop while MessageList still believes it owns the viewport.
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          deltaY: toBottom ? 100 : -100,
        }),
      );
      element.scrollTop = toBottom ? element.scrollHeight : 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, bottom);
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.config.metadata.chatActivationProduction !== true,
    'Requires the dedicated production chat-activation.config.ts',
  );
  // No backend, credentials, saved workspace, or model is involved.
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'fixture_offline', message: 'Fixture has no backend' },
      }),
    }),
  );
});

test('full cached turns expand locally; warm activation and cold eviction reset the mounted window', async ({
  page,
}) => {
  await openFixture(page);
  await expect(panel(page)).toHaveAttribute('data-cached-messages', '36');
  const originalMount = await attribute(panel(page), 'data-mount-id');
  const originalActivation = await attribute(panel(page), 'data-activation-id');
  await expand(page);
  await expectTurns(page, 'a', 7, 12);
  await activate(page, 'a');
  await expectTurns(page, 'a', 7, 12);
  await expect(panel(page)).toHaveAttribute(
    'data-activation-id',
    originalActivation,
  );
  await activate(page, 'b');
  await expect(panel(page)).toBeHidden();
  await activate(page, 'a');
  await expectTurns(page, 'a', 10, 12);
  await expect(panel(page)).toHaveAttribute('data-mount-id', originalMount);
  await expect(panel(page)).not.toHaveAttribute(
    'data-activation-id',
    originalActivation,
  );
  await expand(page);
  await expectTurns(page, 'a', 7, 12);
  await activate(page, 'b');
  await activate(page, 'c');
  await expect(panel(page)).toHaveCount(0);
  await activate(page, 'a');
  await expectTurns(page, 'a', 10, 12);
  await expect(panel(page)).not.toHaveAttribute('data-mount-id', originalMount);
  await expect(panel(page)).toHaveAttribute('data-cached-messages', '36');
  await expand(page);
  await expectTurns(page, 'a', 7, 12);
  await expand(page);
  await expectTurns(page, 'a', 4, 12);
  await expand(page);
  await expectTurns(page, 'a', 1, 12);
  await expect(
    panel(page).getByRole('button', { name: /Show \d+ earlier turns/i }),
  ).toHaveCount(0);
});

test('a genuine completed turn compacts a following reader without deleting cached history', async ({
  page,
}) => {
  await openFixture(page);
  await scrollHistory(page, true);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  await expectTurns(page, 'a', 10, 13);
  await page
    .getByRole('button', { name: 'Complete turn', exact: true })
    .click();
  await expectTurns(page, 'a', 11, 13);
  await expect(panel(page)).toHaveAttribute('data-cached-messages', '39');
  await expand(page);
  await expectTurns(page, 'a', 8, 13);
});

test('turn completion preserves the expanded window for a paused reader', async ({
  page,
}) => {
  await openFixture(page);
  await expand(page);
  await expectTurns(page, 'a', 7, 12);
  await scrollHistory(page, false);
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  await expectTurns(page, 'a', 7, 13);
  await page
    .getByRole('button', { name: 'Complete turn', exact: true })
    .click();
  await expectTurns(page, 'a', 7, 13);
  await expect(panel(page)).toHaveAttribute('data-cached-messages', '39');
});

interface ActivationTiming {
  readyMs: number;
  paintOpportunityMs: number;
  mountId: string;
  activationId: string;
}

async function measureActivation(
  page: Page,
  expectedIds: string[],
  expectedHeadings: string[],
  previousMount: string,
  previousActivation: string,
  kind: 'warm' | 'cold',
): Promise<ActivationTiming> {
  const button = page.getByRole('button', { name: 'Tab A', exact: true });
  await button.evaluate(
    (element, expected) => {
      const target = element as HTMLButtonElement;
      delete target.dataset.activationTiming;
      target.addEventListener(
        'click',
        () => {
          // Capture phase precedes React's bubbling onClick/state transition.
          // Playwright's actionability waits and protocol round trips are excluded.
          const startedAt = performance.now();
          const ready = () => {
            const destination = document.querySelector<HTMLElement>(
              '[data-activation-panel="a"][data-preview-active="true"]',
            );
            if (
              !destination ||
              destination.getBoundingClientRect().height === 0
            ) {
              return null;
            }
            const rows = [
              ...destination.querySelectorAll<HTMLElement>(
                '[data-chat-message-id]',
              ),
            ];
            const editors = [
              ...destination.querySelectorAll('.ProseMirror[role="textbox"]'),
            ];
            const sameMount =
              destination.dataset.mountId === expected.previousMount;
            return sameMount === (expected.kind === 'warm') &&
              destination.dataset.activationId !==
                expected.previousActivation &&
              rows.length === expected.ids.length &&
              rows.every(
                (row, index) =>
                  row.dataset.chatMessageId === expected.ids[index],
              ) &&
              editors.length === expected.headings.length &&
              editors.every(
                (editor, index) =>
                  editor.querySelector('h2, h3')?.textContent ===
                  expected.headings[index],
              )
              ? destination
              : null;
          };
          const observe = () => {
            if (performance.now() - startedAt > 15_000) {
              target.dataset.activationTiming = JSON.stringify({
                error:
                  'Destination rows and Milkdown content did not become ready within 15 seconds',
              });
              return;
            }
            if (!ready()) {
              requestAnimationFrame(observe);
              return;
            }
            const readyMs = performance.now() - startedAt;
            // Readiness was observed before paint. One further frame gives the
            // committed destination a paint opportunity, not compositor proof.
            requestAnimationFrame(() => {
              const destination = ready();
              if (!destination) {
                requestAnimationFrame(observe);
                return;
              }
              target.dataset.activationTiming = JSON.stringify({
                readyMs,
                paintOpportunityMs: performance.now() - startedAt,
                mountId: destination.dataset.mountId,
                activationId: destination.dataset.activationId,
              });
            });
          };
          requestAnimationFrame(observe);
        },
        { capture: true, once: true },
      );
    },
    {
      ids: expectedIds,
      headings: expectedHeadings,
      previousMount,
      previousActivation,
      kind,
    },
  );
  await button.click();
  await expect(button).toHaveAttribute('data-activation-timing', /.+/, {
    timeout: 20_000,
  });
  const result = JSON.parse(
    await attribute(button, 'data-activation-timing'),
  ) as ActivationTiming & {
    error?: string;
  };
  if (result.error) throw new Error(result.error);
  return result;
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples,
    medianMs:
      ((sorted[(sorted.length - 1) >> 1] ?? 0) +
        (sorted[sorted.length >> 1] ?? 0)) /
      2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
  };
}

async function renderedCounts(page: Page) {
  return panel(page).evaluate((element) => {
    const rows = [...element.querySelectorAll('[data-chat-message-id]')];
    const editors = [
      ...element.querySelectorAll('.ProseMirror[role="textbox"]'),
    ];
    const scroller = element.querySelector('[data-chat-thread-root]');
    if (!scroller) throw new Error('Missing history scroller');
    const bounds = scroller.getBoundingClientRect();
    const intersectsViewport = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
      );
    };
    return {
      activePanelMessageRows: rows.length,
      activePanelEditors: editors.length,
      viewportMessageRows: rows.filter(intersectsViewport).length,
      viewportEditors: editors.filter(intersectsViewport).length,
    };
  });
}

test('reports production tab-activation latency for matched full-list and windowed histories', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const results: Record<
    string,
    ReturnType<typeof summary> & {
      readiness: ReturnType<typeof summary>;
      rawSamples: (ActivationTiming &
        Awaited<ReturnType<typeof renderedCounts>>)[];
    }
  > = {};
  const turns = 100;
  for (const presentation of ['windowed', 'full-list'] as const) {
    await openFixture(page, turns, presentation);
    const firstTurn = presentation === 'full-list' ? 1 : turns - 2;
    const mountedTurns = turns - firstTurn + 1;
    const headings = Array.from({ length: mountedTurns }, (_, index) => [
      `Inspection ${firstTurn + index}`,
      `Result ${firstTurn + index}`,
    ]).flat();
    const expectEditorsReady = (tab: string) =>
      expect(
        panel(page, tab).locator('.ProseMirror h2, .ProseMirror h3'),
      ).toHaveText(headings);
    await expectEditorsReady('a');
    for (const activation of ['warm', 'cold'] as const) {
      const rawSamples: (ActivationTiming &
        Awaited<ReturnType<typeof renderedCounts>>)[] = [];
      for (let sample = 0; sample < 10; sample++) {
        const previousMount = await attribute(panel(page), 'data-mount-id');
        const previousActivation = await attribute(
          panel(page),
          'data-activation-id',
        );
        await activate(page, 'b');
        await expectEditorsReady('b');
        if (activation === 'cold') {
          await activate(page, 'c');
          await expectEditorsReady('c');
          await expect(panel(page)).toHaveCount(0);
        } else {
          await expect(panel(page)).toHaveAttribute(
            'data-mount-id',
            previousMount,
          );
          await expect(panel(page)).toBeHidden();
        }
        const timing = await measureActivation(
          page,
          messageIds('a', firstTurn, turns),
          headings,
          previousMount,
          previousActivation,
          activation,
        );
        rawSamples.push({ ...timing, ...(await renderedCounts(page)) });
        await expectTurns(page, 'a', firstTurn, turns);
        await expect(panel(page)).toHaveAttribute(
          'data-cached-messages',
          String(turns * 3),
        );
      }
      results[`${presentation}/${turns}-turns/${activation}`] = {
        ...summary(rawSamples.map((sample) => sample.paintOpportunityMs)),
        readiness: summary(rawSamples.map((sample) => sample.readyMs)),
        rawSamples,
      };
    }
  }
  const report = {
    build: 'production',
    browser: testInfo.project.use.browserName ?? 'chromium',
    viewport: testInfo.project.use.viewport,
    measurement:
      'Browser capture-phase Tab A click to committed destination rows and Milkdown headings ready, plus one further animation frame for a paint opportunity. Readiness is polled with rAF. Excludes Playwright actionability/protocol waits. Not compositor presentation, composer-input latency, or real-user #203 measurements.',
    comparison:
      'Same production build, identical 100-turn cached fixtures: full-list legacy presentation (recentTurnCount undefined) versus windowed presentation (recentTurnCount 3). Ten measured returns to A per scenario: warm A→B→A with retained mount; cold A→B→C→A with verified eviction and remount. Source panels settle before each measured activation.',
    counts:
      'activePanel counts include all mounted rows/editors in the visible Activity panel, including offscreen content; viewport counts intersect its history scroller',
    thresholds: 'Observational only; no approved performance threshold',
    results,
  };
  console.table(
    Object.entries(results).map(([scenario, timing]) => ({
      scenario,
      medianMs: timing.medianMs,
      p95Ms: timing.p95Ms,
      readyMedianMs: timing.readiness.medianMs,
      readyP95Ms: timing.readiness.p95Ms,
      activePanelMessageRows: timing.rawSamples[0]?.activePanelMessageRows,
      activePanelEditors: timing.rawSamples[0]?.activePanelEditors,
    })),
  );
  const reportPath = testInfo.outputPath('chat-tab-activation-latency.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach('chat-tab-activation-latency.json', {
    path: reportPath,
    contentType: 'application/json',
  });
});
