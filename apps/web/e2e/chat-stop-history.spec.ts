// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { installStreams, publish } from './stream-helpers';

import type { AgentHistoryDisplayTurn } from '@huabu/shared';

test.use({ hasTouch: false, viewport: { width: 1440, height: 900 } });

for (const outcome of ['delayed', 'unavailable'] as const) {
  test(`Stop preserves the conversation while history is ${outcome}`, async ({
    page,
    request,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const created = await request.post('/api/canvas', {
      data: { title: `Stop history ${outcome}` },
    });
    expect(created.ok()).toBe(true);
    const { canvasId } = await created.json();
    const nodes = await request.post(`/api/canvas/${canvasId}/execute`, {
      data: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'stop-agent',
                nodeType: 'question',
                position: { x: 100, y: 100 },
                data: {
                  label: 'Stop history conversation',
                  content: 'Earlier question',
                  agentBinding: { kind: 'internal' },
                },
              },
              {
                id: 'other-tab',
                nodeType: 'note',
                position: { x: 100, y: 450 },
                size: { width: 300, height: 180 },
                data: { label: 'Other tab', content: 'Another preview tab' },
              },
            ],
          },
        ],
        originator: { source: 'ui' },
      },
    });
    expect(nodes.ok()).toBe(true);
    const association = await request.post(
      `/api/canvas/${canvasId}/nodes/stop-agent/association`,
      {
        data: { kind: 'initialize' },
      },
    );
    expect(association.ok()).toBe(true);
    const { node } = await association.json();
    const threadId: string = node.data.threadId;
    await installStreams(page);
    await page.addInitScript((id) => {
      localStorage.setItem(
        `huabu.viewport.${id}`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
    }, canvasId);
    const prior: AgentHistoryDisplayTurn[] = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `old-${index}`,
        messages: [
          { role: 'user', content: `Earlier question ${index}` },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'text',
                text: `## Earlier answer ${index}\n\n${'Keep this paragraph at its reading position. '.repeat(15)}`,
              },
            ],
          },
        ],
      }),
    );
    let stopped = false;
    let historyReady = false;
    let readsAfterStop = 0;
    let stopRequests = 0;
    let requestId: string | undefined;
    await page.route(`**/api/agent/history/${threadId}/page?**`, (route) => {
      if (stopped) readsAfterStop++;
      const settled =
        historyReady || (outcome === 'delayed' && readsAfterStop >= 3);
      return route.fulfill({
        json: {
          threadId,
          turns: [
            ...prior,
            ...(stopped
              ? [
                  {
                    id: 'stopped-turn',
                    ...(settled ? {} : { active: true }),
                    messages: [
                      { role: 'user', content: 'Stop this response' },
                      {
                        role: 'assistant',
                        parts: [
                          {
                            kind: 'text',
                            text: 'Partial response retained after Stop.',
                          },
                        ],
                      },
                      ...(settled
                        ? [{ role: 'status', status: 'interrupted' }]
                        : []),
                    ],
                  },
                ]
              : []),
          ],
          hasMore: false,
        },
      });
    });
    await page.route(`**/api/agent/stream/${threadId}?**`, (route) =>
      route.fulfill({ status: 404, json: { message: 'No active run' } }),
    );
    await page.route('**/api/agent', (route) => {
      requestId = route.request().postDataJSON().requestId;
      return route.fulfill({
        headers: { 'x-test-stream': 'true' },
        json: {
          key: threadId,
          events: [
            {
              type: 'accepted',
              data: { threadId, requestId, turnStartSeq: 20 },
            },
            {
              type: 'text_delta',
              data: { content: 'Partial response retained after Stop.' },
            },
          ],
        },
      });
    });
    await page.route(`**/api/agent/stop/${threadId}**`, async (route) => {
      stopped = true;
      stopRequests++;
      if (outcome === 'delayed') {
        await publish(page, threadId, {
          type: 'done',
          data: { message: '', meta: { stopReason: 'aborted' } },
        });
      }
      await route.fulfill({
        json: {
          stopped: true,
          acceptance: { threadId, requestId, turnStartSeq: 20 },
          request: { id: requestId, accepted: true },
        },
      });
    });
    await page.goto(`/canvas/${canvasId}?node=stop-agent`);
    await page
      .locator('.react-flow__node[data-id="stop-agent"]')
      .dblclick({ position: { x: 20, y: 20 } });
    const input = page.locator('textarea[name="agent-message"]:visible');
    await expect(input).toBeVisible();
    await expect(
      page.getByText('Earlier answer 9', { exact: true }),
    ).toBeVisible();
    await input.fill('Stop this response');
    await input.press('Enter');
    await expect(
      page.getByText('Partial response retained after Stop.', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      new MutationObserver(() => {
        if (
          document.body.textContent?.includes(
            'The completed turn is not available in history yet.',
          )
        )
          document.documentElement.dataset.historyErrorSeen = 'true';
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => stopRequests).toBe(1);
    const errorBanner = page.getByText(
      'The completed turn is not available in history yet.',
      { exact: false },
    );
    await expect(errorBanner).not.toBeVisible();
    await expect(input).toBeEditable();
    if (outcome === 'unavailable') {
      await expect(errorBanner).toBeVisible({ timeout: 8_000 });
      expect(readsAfterStop).toBe(4);
      await page.screenshot({ path: info.outputPath('history-retry.png') });
      historyReady = true;
      await page
        .getByRole('button', { name: 'Retry', exact: true })
        .filter({ hasText: /^Retry$/ })
        .click();
    }
    await expect(
      page.locator('[data-chat-message-id="stopped-turn:1"]'),
    ).toBeVisible();
    await expect(errorBanner).not.toBeVisible();
    if (outcome === 'delayed')
      await expect(page.locator('html')).not.toHaveAttribute(
        'data-history-error-seen',
        'true',
      );
    await expect(
      page.getByRole('button', { name: 'Stop', exact: true }),
    ).not.toBeVisible();
    await input.fill('Draft survives switching tabs');
    const scroller = page.locator('[data-chat-thread-root]:visible');
    await scroller.hover();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(500);
    const anchor = await scroller.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const row = [
        ...element.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
      ].find((item) => item.getBoundingClientRect().bottom > top + 1);
      if (!row) throw new Error('Missing reading anchor');
      return {
        id: row.dataset.chatMessageId,
        offset: row.getBoundingClientRect().top - top,
      };
    });
    await page
      .locator('.react-flow__node[data-id="other-tab"]')
      .dblclick({ position: { x: 20, y: 20 } });
    await expect(
      page.getByText('Another preview tab', { exact: true }).last(),
    ).toBeVisible();
    await page.getByRole('tab', { name: /Stop history conversation/ }).click();
    await expect(input).toHaveValue('Draft survives switching tabs');
    await expect
      .poll(() =>
        scroller.evaluate((element, saved) => {
          const row = element.querySelector<HTMLElement>(
            `[data-chat-message-id="${saved.id}"]`,
          );
          return row
            ? Math.abs(
                row.getBoundingClientRect().top -
                  element.getBoundingClientRect().top -
                  saved.offset,
              )
            : Infinity;
        }, anchor),
      )
      .toBeLessThanOrEqual(3);
    await expect(errorBanner).not.toBeVisible();
    await page.screenshot({ path: info.outputPath('stop-and-tab-return.png') });
    expect(errors).toEqual([]);
  });
}
