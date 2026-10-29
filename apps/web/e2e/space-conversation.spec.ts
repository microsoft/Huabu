// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { readViewportTransform } from './helpers';

test('opens and continues a child Agent in the parent without leaking canvas selection', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('huabu.language', 'en'));
  const parentResponse = await page.request.post('/api/canvas', {
    data: { title: 'Parent board' },
  });
  const { canvasId: parent } = await parentResponse.json();
  const childResponse = await page.request.post(
    `/api/canvas/${parent}/children`,
    { data: { title: 'Child task', position: { x: 120, y: 100 } } },
  );
  expect(childResponse.ok(), await childResponse.text()).toBe(true);
  const parentState = await (
    await page.request.get(`/api/canvas/${parent}`)
  ).json();
  const entry = parentState.state.nodes.find(
    (node: { type: string }) => node.type === 'spacePreview',
  );
  const child = entry.data.targetCanvasId;
  const createAgent = await page.request.post(`/api/canvas/${child}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'child-agent',
              nodeType: 'question',
              position: { x: 100, y: 100 },
              data: {
                label: 'Review the draft',
                content: 'Review the draft',
                agentBinding: { kind: 'internal' },
              },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'remote-conversation-test' },
    },
  });
  expect(createAgent.ok(), await createAgent.text()).toBe(true);
  const association = await page.request.post(
    `/api/canvas/${child}/nodes/child-agent/association`,
    { data: { kind: 'initialize' } },
  );
  expect(association.ok(), await association.text()).toBe(true);
  const { node: agent } = await association.json();
  const threadId = agent.data.threadId;
  expect(threadId).toBeTruthy();
  const createNote = await page.request.post(`/api/canvas/${parent}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'parent-note',
              nodeType: 'note',
              position: { x: 120, y: 350 },
              data: {
                label: 'Parent reference',
                content: 'Do not send this parent reference',
              },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'remote-conversation-test' },
    },
  });
  expect(createNote.ok(), await createNote.text()).toBe(true);
  await page.addInitScript(
    (id) =>
      localStorage.setItem(
        `huabu.viewport.${id}`,
        JSON.stringify({ x: 30, y: 30, zoom: 1 }),
      ),
    parent,
  );
  await page.route('**/api/canvas/cards/query', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.spaces[child]?.status === 'ready') {
      body.spaces[child].activity = [
        {
          nodeId: agent.id,
          threadId,
          title: 'Review the draft',
          status: 'unread',
          agentBinding: { kind: 'internal' },
        },
      ];
    }
    await route.fulfill({ response, json: body });
  });
  await page.route('https://example.test/review-result.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="currentColor"/></svg>',
    }),
  );
  await page.route(`**/api/agent/history/${threadId}/page?**`, (route) =>
    route.fulfill({
      json: {
        threadId,
        turns: [
          {
            id: 'turn-1',
            messages: [
              { role: 'user', content: 'Review the draft' },
              {
                role: 'assistant',
                parts: [
                  {
                    kind: 'text',
                    text: 'The child conversation is available here.\n\n![Review result](https://example.test/review-result.svg)',
                  },
                ],
              },
            ],
          },
        ],
        hasMore: false,
      },
    }),
  );
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/agent', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `event: accepted\ndata: ${JSON.stringify({ threadId, turnStartSeq: 1 })}\n\nevent: text_delta\ndata: {"content":"Continued in the child Space."}\n\nevent: done\ndata: {"message":"Done"}\n\n`,
    });
  });
  await page.goto(`/canvas/${parent}`);
  const badge = page.locator(`[data-space-agent-thread="${threadId}"]`);
  await expect(badge).toBeVisible();
  const viewport = await readViewportTransform(page);
  await badge.click();
  await expect(
    page.getByRole('tab').locator('.lucide-message-circle-question-mark'),
  ).toBeVisible();
  await expect(
    page.getByText('The child conversation is available here.'),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/canvas/${parent}$`));
  expect(await readViewportTransform(page)).toBe(viewport);
  expect(submissions).toHaveLength(0);
  await page.locator('.react-flow__node[data-id="parent-note"]').click();
  await expect(page.locator('[data-context-selection]')).toHaveCount(0);
  const input = page.locator('textarea').last();
  await expect(input).toHaveAttribute('placeholder', 'Message…');
  await expect(
    page.getByRole('button', { name: 'Child task: Open Space', exact: true }),
  ).toHaveText('Child task');
  await expect(
    page.getByText('Runs in Child task', { exact: true }),
  ).toHaveCount(0);
  const sourceLink = await page
    .getByRole('button', { name: 'Child task: Open Space', exact: true })
    .boundingBox();
  const messageViewport = await page
    .locator('[data-chat-thread-root]')
    .boundingBox();
  if (!sourceLink || !messageViewport)
    throw new Error('Missing conversation layout');
  const sourceGap = messageViewport.y - sourceLink.y - sourceLink.height;
  expect(sourceGap).toBeGreaterThanOrEqual(0);
  expect(sourceGap).toBeLessThanOrEqual(4);
  const resultImage = page.getByRole('img', {
    name: 'Review result',
    exact: true,
  });
  await expect(resultImage).toBeVisible();
  await expect
    .poll(() =>
      resultImage.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(80);
  await page.evaluate(() => {
    document.addEventListener(
      'dragstart',
      (event) => {
        const target = event.target;
        if (
          target instanceof HTMLImageElement &&
          target.alt === 'Review result'
        ) {
          setTimeout(() => {
            target.dataset.dragCancelled = String(event.defaultPrevented);
          }, 0);
        }
      },
      { once: true, capture: true },
    );
  });
  await resultImage.dragTo(page.locator('.react-flow__pane'), {
    targetPosition: { x: 50, y: 600 },
  });
  await expect(resultImage).toHaveAttribute('data-drag-cancelled', 'true');
  const parentAfterDrag = await (
    await page.request.get(`/api/canvas/${parent}`)
  ).json();
  expect(
    parentAfterDrag.state.nodes.map((node: { id: string }) => node.id).sort(),
  ).toEqual([entry.id, 'parent-note'].sort());
  await input.fill('Continue the original task');
  await input.press('Enter');
  await expect(page.getByText('Continued in the child Space.')).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    threadId,
    canvasId: child,
    anchorNodeId: agent.id,
    canvasContext: { selectedNodes: [] },
  });
  await expect(
    page.getByRole('button', { name: 'Add as note', exact: true }).first(),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('parent-conversation.png'),
  });
  let ownerUnavailable = false;
  let invocationToken = 'run-1';
  let viewed = false;
  const acknowledgements: string[] = [];
  await page.route(`**/api/agent/owner/${threadId}?**`, async (route) => {
    if (ownerUnavailable) {
      await route.fulfill({
        status: 503,
        json: { message: 'Temporarily unavailable' },
      });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.source = { ...body.source, status: 'done', invocationToken, viewed };
    await route.fulfill({ response, json: body });
  });
  await page.route(
    `**/api/canvas/${child}/nodes/${agent.id}/viewed`,
    async (route) => {
      const token = route.request().postDataJSON().invocationToken;
      acknowledgements.push(token);
      if (token === invocationToken) viewed = true;
      await route.fulfill({
        json: { acknowledged: token === invocationToken },
      });
    },
  );
  await page.reload();
  await expect(
    page.getByText('The child conversation is available here.'),
  ).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(acknowledgements).toEqual([]);

  await input.click();
  await expect.poll(() => acknowledgements).toContain('run-1');
  await input.fill('Keep this unsent draft');
  await input.evaluate((element) =>
    element.setAttribute('data-retention-probe', 'retained'),
  );
  ownerUnavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText(
    'Temporarily unavailable',
  );
  await expect(input).toHaveAttribute('data-retention-probe', 'retained');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Keep this unsent draft');
  await page.screenshot({
    path: testInfo.outputPath('parent-conversation-reconnecting.png'),
  });
  ownerUnavailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(input).toHaveAttribute('data-retention-probe', 'retained');

  let historyRequested = false;
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route(
    `**/api/agent/history/${threadId}/page?**`,
    async (route) => {
      historyRequested = true;
      await historyGate;
      await route.fulfill({
        json: {
          threadId,
          hasMore: false,
          turns: [
            {
              id: 'turn-2',
              messages: [
                { role: 'user', content: 'Work started elsewhere' },
                {
                  role: 'assistant',
                  parts: [
                    { kind: 'text', text: 'New result completed elsewhere.' },
                  ],
                },
              ],
            },
          ],
        },
      });
    },
  );
  invocationToken = 'run-2';
  viewed = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => historyRequested).toBe(true);
  expect(acknowledgements).not.toContain('run-2');
  releaseHistory();
  await expect(page.getByText('New result completed elsewhere.')).toBeVisible();
  await expect.poll(() => acknowledgements).toContain('run-2');
  await expect(input).toHaveValue('Keep this unsent draft');
  await page
    .getByRole('button', { name: 'Child task: Open Space', exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/canvas/${child}\\?node=${agent.id}$`),
  );
  invocationToken = 'run-3';
  viewed = false;
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/canvas/${parent}$`));
  await expect(page.getByText('New result completed elsewhere.')).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(acknowledgements).not.toContain('run-3');
  await input.click();
  await expect.poll(() => acknowledgements).toContain('run-3');
  await page.unrouteAll({ behavior: 'wait' });
});
