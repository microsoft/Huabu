// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { SPACE_SHORTCUT_SIZE } from '@huabu/shared/canvas-engine';

import type { SpaceCardAgent } from '@huabu/shared';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('Space Scale resizes all card content and persists independently from Width', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('huabu.language', 'en'));
  const responses = await Promise.all(
    ['Scale board', 'Matching compact cards'].map((title) =>
      page.request.post('/api/canvas', { data: { title } }),
    ),
  );
  const [{ canvasId: source }, { canvasId: target }] = await Promise.all(
    responses.map((r) => r.json()),
  );
  const created = await page.request.post(`/api/canvas/${source}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'scaled-space',
              nodeType: 'spacePreview',
              position: { x: 500, y: 140 },
              size: { width: 360 },
              data: { targetCanvasId: target },
            },
            {
              id: 'paired-question',
              nodeType: 'question',
              position: { x: 80, y: 140 },
              size: { width: 360 },
              data: {
                content: 'Matching compact cards',
                label: 'Matching compact cards',
              },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'card-scale-test' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.addInitScript((id) => {
    localStorage.setItem(
      `huabu.viewport.${id}`,
      JSON.stringify({ x: 40, y: 60, zoom: 1 }),
    );
  }, source);
  await page.route('**/api/canvas/cards/query', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.spaces[target]?.status === 'ready') {
      body.spaces[target].activity = [
        {
          nodeId: 'alignment-agent',
          threadId: 'alignment-thread',
          title: 'Review',
          status: 'unread',
          agentBinding: { kind: 'internal' },
        } satisfies SpaceCardAgent,
      ];
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/canvas/${source}`);
  const card = page.locator('[data-space-shortcut]');
  const node = page.locator('.react-flow__node-spacePreview');
  await expect(card).toContainText('Matching compact cards');
  await expect(page.locator('.question-conversation-card')).toHaveCSS(
    'padding',
    '16px',
  );
  await expect(card).toHaveCSS('padding', '16px 14px');
  await expect(card.locator('[data-space-agent-badge]')).toHaveCount(1);
  const assertAlignedCards = async () => {
    await expect(async () => {
      const geometry = await page
        .locator('.react-flow__node-question, .react-flow__node-spacePreview')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const space = node.querySelector<HTMLElement>(
              '[data-space-shortcut]',
            );
            const required = (selector: string) => {
              const element = node.querySelector<HTMLElement>(selector);
              if (!element)
                throw new Error(`Missing alignment element: ${selector}`);
              return element;
            };
            const title = space
              ? required('[data-space-type-icon]').nextElementSibling
              : required('.question-conversation-question');
            if (!title) throw new Error('Missing title');
            const icon = required(
              space
                ? '[data-space-type-icon] svg'
                : '.question-conversation-agent svg',
            );
            const statusIcon = required(
              space
                ? '[data-space-agent-badge] svg'
                : '.question-conversation-status svg',
            );
            const statusText = required(
              space
                ? '[data-space-agent-badge] > span > span:last-child'
                : '.question-conversation-status > span:last-child',
            );
            const scale = space
              ? parseFloat(getComputedStyle(space).zoom)
              : parseFloat(getComputedStyle(title).fontSize) / 24;
            const left = node.getBoundingClientRect().left;
            const textLeft = (element: Element) =>
              (element.getBoundingClientRect().left - left) / scale;
            const center = (element: Element) => {
              const rect = element.getBoundingClientRect();
              return (rect.left + rect.width / 2 - left) / scale;
            };
            return {
              title: textLeft(title),
              badge: textLeft(
                required(
                  space
                    ? '[data-space-agent-badge]'
                    : '.question-conversation-status',
                ),
              ),
              statusGap:
                (statusText.getBoundingClientRect().left -
                  statusIcon.getBoundingClientRect().right) /
                scale,
              icon: center(icon),
            };
          }),
        );
      expect(geometry).toHaveLength(2);
      for (const card of geometry) {
        expect(card.title).toBeCloseTo(52, 1);
        expect(card.badge).toBeCloseTo(16, 1);
        expect(card.statusGap).toBeCloseTo(6, 1);
        expect(card.icon).toBeCloseTo(30, 1);
      }
    }).toPass({ timeout: 5000 });
  };
  await assertAlignedCards();
  await page.screenshot({ path: testInfo.outputPath('aligned-cards.png') });
  await expect(card.locator(':scope > div > div').last()).toHaveCSS(
    'height',
    '32px',
  );
  await expect(node.locator('.semantic-lod-node')).toHaveCSS(
    'border-top-width',
    '2px',
  );
  const questionMain = page.locator('.question-conversation-main');
  expect(
    await questionMain.evaluate((element) => {
      const icon = element
        .querySelector('.question-conversation-agent')
        ?.getBoundingClientRect();
      const title = element
        .querySelector('.question-conversation-question')
        ?.getBoundingClientRect();
      if (!icon || !title)
        throw new Error('Missing Question title or identity');
      return title.left - icon.right;
    }),
  ).toBeCloseTo(8, 1);
  const icon = card.locator('[data-space-type-icon] svg');
  const initialIcon = await icon.boundingBox();
  if (!initialIcon) throw new Error('Missing Space identity');
  await card.click({ position: { x: 10, y: 40 } });
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  const scale = page.getByRole('spinbutton', { name: 'Scale', exact: true });
  await expect(scale).toHaveValue('100');
  await scale.fill('150');
  await scale.press('Enter');
  await expect(node).toHaveCSS('width', '540px');
  await expect(card).toHaveCSS('zoom', '1.5');
  await assertAlignedCards();
  await expect(node.locator('.semantic-lod-node')).toHaveCSS(
    'border-top-width',
    '2px',
  );
  await expect
    .poll(async () => (await icon.boundingBox())?.width)
    .toBeCloseTo(initialIcon.width * 1.5, 1);
  await page
    .getByRole('spinbutton', { name: 'Width', exact: true })
    .fill('480');
  await page
    .getByRole('spinbutton', { name: 'Width', exact: true })
    .press('Enter');
  await expect(node).toHaveCSS('width', '480px');
  await expect(scale).toHaveValue('150');
  await assertAlignedCards();
  await expect
    .poll(async () => {
      const saved = await page.request.get(`/api/canvas/${source}`);
      const body = await saved.json();
      const stored = body.state.nodes.find(
        (entry: { id: string }) => entry.id === 'scaled-space',
      );
      return {
        width: stored.style.width,
        fontSize: stored.data.style?.fontSize,
      };
    })
    .toEqual({ width: 480, fontSize: 36 });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('paired-cards.png') });
  await page.reload();
  await expect(node).toHaveCSS('width', '480px');
  await expect(card).toHaveCSS('zoom', '1.5');
  await card.click({ position: { x: 10, y: 40 } });
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  await expect(scale).toHaveValue('150');
  await scale.fill('100');
  await scale.press('Enter');
  await expect(node).toHaveCSS('width', '320px');
  await expect(card).toHaveCSS('zoom', '1');
  await page.locator('[data-canvas-root]').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(node).toHaveCSS('width', '480px');
  await expect(card).toHaveCSS('zoom', '1.5');
  await expect
    .poll(async () => {
      const saved = await page.request.get(`/api/canvas/${source}`);
      const body = await saved.json();
      const stored = body.state.nodes.find(
        (entry: { id: string }) => entry.id === 'scaled-space',
      );
      return {
        width: stored.style.width,
        fontSize: stored.data.style.fontSize,
      };
    })
    .toEqual({ width: 480, fontSize: 36 });
});

test('Space cards show activity and rename inline without entering the target', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('huabu.language', 'en');
    localStorage.setItem(
      'huabu-sketch-tools',
      JSON.stringify({ state: { inputModePreference: 'mouse' }, version: 0 }),
    );
  });
  const targetResponse = await page.request.post('/api/canvas', {
    data: { title: 'Card task' },
  });
  const { canvasId: target } = await targetResponse.json();
  const agentsCreated = await page.request.post(
    `/api/canvas/${target}/execute`,
    {
      data: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              'Research',
              'Review',
              'Implementation',
              'Verification',
              'Quiet session',
              ...Array.from(
                { length: 27 },
                (_, index) => `Additional review ${index + 1}`,
              ),
            ].map((label, index) => ({
              id: `node-card-agent-${index}`,
              nodeType: 'question',
              position: { x: index * 300, y: 0 },
              data: { label, agentBinding: { kind: 'internal' } },
            })),
          },
        ],
        originator: { source: 'ui', tabId: 'space-card-test' },
      },
    },
  );
  expect(agentsCreated.ok(), await agentsCreated.text()).toBe(true);
  const sourceResponse = await page.request.post('/api/canvas', {
    data: { title: 'Card board' },
  });
  const { canvasId: source } = await sourceResponse.json();
  const created = await page.request.post(`/api/canvas/${source}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'card-entry',
              nodeType: 'spacePreview',
              position: { x: 80, y: 140 },
              selectOnCreate: false,
              data: { targetCanvasId: target },
            },
          ],
        },
      ],
      originator: { source: 'ui', tabId: 'space-card-test' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  let activityMode: 'mixed' | 'single' | 'idle' | 'approval' = 'mixed';
  let failActivity = false;
  await page.route('**/api/canvas/cards/query', async (route) => {
    if (failActivity) {
      await route.fulfill({ status: 503, json: { error: 'Offline' } });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    if (body.spaces[target]?.status === 'ready') {
      body.spaces[target].activity.forEach(
        (agent: SpaceCardAgent, index: number) => {
          agent.status =
            index >= 5 || (activityMode === 'approval' && index < 3)
              ? 'approval'
              : (['running', 'approval', 'error', 'unread', 'idle'] as const)[
                  index
                ];
          if (
            activityMode === 'idle' ||
            (activityMode === 'single' && index > 0)
          )
            agent.status = 'idle';
          if (index < 3) {
            agent.agentBinding = {
              kind: 'external',
              alias: index < 2 ? 'Reviewer' : 'Builder',
              profileId: index < 2 ? 'reviewer' : 'builder',
            };
            agent.agentIcon = {
              shape: index < 2 ? 'flower' : 'diamond',
              color: index < 2 ? 'green' : 'blue',
            };
          }
        },
      );
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/canvas/${source}`);
  const card = page.locator('[data-space-shortcut]');
  await expect(card).toContainText('Card task');
  await expect(card).toHaveCSS('font-size', '24px');
  await expect(card.locator('[data-space-agent-thread]')).toHaveCount(1);
  await expect(card.locator('[data-agent-status="idle"]')).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: 'Show 30 more conversations' }),
  ).toHaveText('+30');
  await expect(
    card.getByRole('button', {
      name: 'Reviewer · Research · Running — Open conversation',
      exact: true,
    }),
  ).toBeVisible();
  await expect(card).not.toContainText('nodes');
  await page.getByRole('button', { name: /Canvas zoom/ }).click();
  await page.getByRole('menuitem', { name: /Reset.*100%/ }).click();
  const spaceIcon = card.locator('[data-space-type-icon]');
  await expect(spaceIcon.locator('svg')).toHaveCSS('width', '22px');
  await expect(spaceIcon.locator('svg')).toHaveCSS('height', '22px');
  const runningBadge = card.locator('[data-space-agent-badge="running"]');
  await expect(runningBadge).toHaveCSS('padding-left', '6px');
  await expect(runningBadge).toHaveCSS('padding-top', '3px');
  await expect(runningBadge).toHaveCSS('border-radius', '6px');
  await expect(runningBadge.locator(':scope > span')).toHaveCSS('gap', '6px');
  await expect(card.locator(':scope > div')).toHaveCSS('row-gap', '8px');
  await expect(card).toHaveCSS('padding', '16px 14px');
  const badgeWidth = await runningBadge.evaluate(
    (element) => getComputedStyle(element).width,
  );
  await expect(card.locator('[data-agent-fit-status="running"]')).toHaveCSS(
    'width',
    badgeWidth,
  );
  const firstAvatar = card.locator('[data-space-agent-thread] svg').first();
  expect((await firstAvatar.boundingBox())?.width).toBeCloseTo(24, 1);
  await expect(
    card.locator(
      '.question-agent-ring-running, .question-agent-ring-approval, .question-agent-ring-error',
    ),
  ).toHaveCount(0);
  await expect(card.locator('[data-agent-status="running"]')).toHaveText(
    'Running',
  );
  await expect(card.locator('[data-agent-status="running"]')).toHaveCSS(
    'font-size',
    '18px',
  );
  await expect(
    card.locator(
      '.lucide-loader-circle, .lucide-circle-alert, .lucide-circle-help, .lucide-circle',
    ),
  ).toHaveCount(0);
  await card
    .getByRole('button', {
      name: 'Reviewer · Research · Running — Open conversation',
      exact: true,
    })
    .hover();
  await expect(page.getByRole('tooltip')).toHaveText('Research');
  await page.mouse.move(0, 0);
  await expect(card.locator('[data-space-shortcut-summary]')).toHaveCSS(
    'font-size',
    '18px',
  );
  const initialHeight = await card.evaluate((element) => element.clientHeight);
  activityMode = 'single';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    card.getByRole('button', { name: /Show .* more conversation/ }),
  ).toHaveCount(0);
  await expect(card.locator('[data-space-agent-thread]')).toHaveCount(1);
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    initialHeight,
  );
  activityMode = 'idle';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(card.locator('[data-space-agent-activity]')).toHaveCount(0);
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    initialHeight,
  );
  activityMode = 'mixed';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    card.getByRole('button', { name: 'Show 30 more conversations' }),
  ).toBeVisible();
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    initialHeight,
  );

  await card.getByText('Card task', { exact: true }).click();
  await expect(card.locator('input')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Rename Space', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('menuitem', { name: 'Rename Space', exact: true })
    .click();
  const input = card.getByRole('textbox', { name: 'Rename Space' });
  await expect(input).toBeFocused();
  await input.fill('Renamed task');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(card).toContainText('Renamed task');
  await expect(page).toHaveURL(`/canvas/${source}`);
  const saved = await page.request.get(`/api/canvas/${target}`);
  expect((await saved.json()).title).toBe('Renamed task');

  await page.keyboard.press('F2');
  await expect(input).toBeVisible();
  await input.fill('Cancelled');
  await input.press('Escape');
  await expect(card).toContainText('Renamed task');
  await expect(card).not.toContainText('Cancelled');
  await page.keyboard.press('F2');
  await input.fill('Saved on blur');
  await card.locator('[data-space-shortcut-summary]').click();
  await expect(input).toHaveCount(0);
  await expect(card).toContainText('Saved on blur');
  failActivity = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(card.locator('[role="status"]')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const retry = page.getByRole('menuitem', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('space-more-actions.png'),
  });
  failActivity = false;
  await retry.click();
  await expect(card.locator('[role="status"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('space-card.png') });
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  await page.locator('input[name="node-width"]').fill('720');
  await page.locator('input[name="node-width"]').press('Enter');
  await expect
    .poll(() => card.locator('[data-space-agent-thread]').count())
    .toBeGreaterThan(3);
  expect(await card.evaluate((element) => element.clientHeight)).toBe(
    initialHeight,
  );
  await page.screenshot({ path: testInfo.outputPath('space-card-wide.png') });
  await page.locator('input[name="node-width"]').fill('240');
  await page.locator('input[name="node-width"]').press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node-spacePreview')).toHaveCSS(
    'width',
    '240px',
  );
  await expect
    .poll(() =>
      card.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  expect(
    await card.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(SPACE_SHORTCUT_SIZE.autoMaxHeight);
  expect(
    await card.evaluate((element) => element.clientHeight),
  ).toBeGreaterThanOrEqual(initialHeight);
  const headerGeometry = await spaceIcon.evaluate((element) => {
    const icon = element.getBoundingClientRect();
    const title = element.nextElementSibling?.getBoundingClientRect();
    const header = element.parentElement?.getBoundingClientRect();
    if (!title || !header) throw new Error('Missing card title geometry');
    return {
      gap: title.left - icon.right,
      leftInset: icon.left - header.left,
      topInset: icon.top - header.top,
    };
  });
  expect(headerGeometry.gap).toBeCloseTo(8, 1);
  expect(headerGeometry.leftInset).toBeCloseTo(0, 1);
  expect(headerGeometry.topInset).toBeCloseTo(0, 1);
  for (const session of await card.locator('[data-space-agent-thread]').all()) {
    expect(
      await session.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  const timestamp = card.locator('[data-space-shortcut-summary]');
  await expect(timestamp).toHaveText('now');
  const footer = timestamp.locator('..').locator('..');
  const timestampBox = await timestamp.boundingBox();
  const footerBox = await footer.boundingBox();
  if (!timestampBox || !footerBox)
    throw new Error('Missing card footer geometry');
  expect(
    Math.abs(
      timestampBox.x + timestampBox.width - footerBox.x - footerBox.width,
    ),
  ).toBeLessThan(1);
  expect(
    Math.abs(
      timestampBox.y +
        timestampBox.height / 2 -
        footerBox.y -
        footerBox.height / 2,
    ),
  ).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('space-card-narrow.png') });
  const more = card.getByRole('button', { name: /Show .* more conversation/ });
  const visibleSessions = await card
    .locator('[data-space-agent-thread]')
    .count();
  await more.click();
  await expect(
    page.getByRole('menuitem', { name: /Verification/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(`/canvas/${source}`);
  await expect(card.locator('input')).toHaveCount(0);
  await expect(page.getByRole('menuitem')).toHaveCount(31 - visibleSessions);
  const menu = page.getByRole('menu');
  expect(
    await menu.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(256);
  expect(
    await menu.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('space-card-overflow.png'),
  });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('menuitem', { name: /Verification/ }),
  ).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page
    .getByRole('menuitem', {
      name: 'Reviewer · Review · Approval needed — Open conversation',
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(`/canvas/${target}?node=node-card-agent-1`);
  await expect(page.getByRole('tab', { name: /Review/ })).toBeVisible();
  await expect(page.locator('[data-chat-thread-root]')).toBeVisible();
  await page
    .getByRole('button', { name: 'Back to Card board', exact: true })
    .click();
  await expect(page).toHaveURL(`/canvas/${source}`);
  await card.click({ position: { x: 10, y: 40 } });
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  await page.locator('input[name="node-width"]').fill('360');
  await page.locator('input[name="node-width"]').press('Enter');
  await page.keyboard.press('Escape');
  await card
    .getByRole('button', {
      name: 'Reviewer · Research · Running — Open conversation',
      exact: true,
    })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/canvas/${target}?node=node-card-agent-0`);
  await expect(page.getByRole('tab', { name: /Research/ })).toBeVisible();
  await page
    .getByRole('button', { name: 'Back to Card board', exact: true })
    .click();
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: /Reviewer · Review ·/ }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: /Verification/ }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/canvas/${target}?node=node-card-agent-3`);
  await expect(page.getByRole('tab', { name: /Verification/ })).toBeVisible();
  await page
    .getByRole('button', { name: 'Back to Card board', exact: true })
    .click();
  await card.click({ position: { x: 10, y: 40 } });
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  await page.locator('input[name="node-width"]').fill('240');
  await page.locator('input[name="node-width"]').press('Enter');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F2');
  await input.fill('Long task title that wraps onto a second line');
  await input.press('Enter');
  activityMode = 'approval';
  await page.reload();
  await expect(card.locator('[data-space-agent-thread]')).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: 'Show 31 more conversations' }),
  ).toBeVisible();
  expect(
    await card.evaluate((element) => element.clientHeight),
  ).toBeLessThanOrEqual(SPACE_SHORTCUT_SIZE.autoMaxHeight);
  await page.screenshot({
    path: testInfo.outputPath('space-card-many-sessions.png'),
  });
  const activityRow = card.locator('[data-space-agent-activity]');
  const rowBox = await activityRow.boundingBox();
  if (!rowBox) throw new Error('Missing activity-row geometry');
  await activityRow.dblclick({
    position: { x: rowBox.width - 2, y: rowBox.height / 2 },
  });
  await expect(page).toHaveURL(`/canvas/${target}`);
  await page
    .getByRole('button', { name: 'Back to Card board', exact: true })
    .click();
  await expect(page).toHaveURL(`/canvas/${source}`);
  await page.unrouteAll({ behavior: 'wait' });
});
