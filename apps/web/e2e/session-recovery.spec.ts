// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as CanvasModule from '../src/store/canvasStore';

test('keeps edits covered during discovery failure and saves them after cookie recovery', async ({
  page,
}, testInfo) => {
  let expired = false;
  let discoveryRequests = 0;
  let refusedSaves = 0;
  const member = {
    provider: 'bubble',
    principal: { principalId: 'carol', kind: 'user', displayName: 'Carol' },
    member: true,
    owner: false,
  };
  await page.route('**/api/identity', (route) =>
    route.fulfill({ status: expired ? 401 : 200, json: expired ? {} : member }),
  );
  await page.route('**/bubble/v1/auth/authenticators', (route) => {
    discoveryRequests++;
    return route.fulfill({ status: 503, json: {} });
  });
  await openNewCanvas(page);
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  if (!canvasId) throw new Error('Missing Space');
  const contentUrl = `/api/canvas/${canvasId}/nodes/node-recovery-note/content`;
  const created = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-recovery-note',
              nodeType: 'note',
              data: { label: 'Recovery note', content: 'Saved before expiry' },
              position: { x: 100, y: 100 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-session-recovery' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await page.route(`**${contentUrl}`, (route) => {
    if (expired && route.request().method() === 'PUT') {
      refusedSaves++;
      return route.fulfill({
        status: 401,
        json: { code: 'IDENTITY_REQUIRED', message: 'Session expired' },
      });
    }
    return route.continue();
  });

  expired = true;
  const saved = await page.evaluate(async () => {
    const canvasPath = '/src/store/canvasStore.ts';
    const clientPath = '/src/api/_client.ts';
    const { default: canvas, savedBeforeSignOut } = (await import(
      canvasPath
    )) as typeof CanvasModule;
    canvas.getState().updateNodeData('node-recovery-note', {
      content: 'Retained while the session was expired',
    });
    const saved = await savedBeforeSignOut();
    const { AUTH_REQUIRED_EVENT } = await import(clientPath);
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    return saved;
  });
  expect(saved).toBe(false);
  expect(refusedSaves).toBeGreaterThan(0);
  const cover = page.getByRole('dialog');
  await expect(cover).toBeVisible();
  await expect(page.locator('[inert]').first()).toHaveAttribute('inert', '');
  expect(
    await page
      .locator('.react-flow__pane')
      .evaluate((pane) => Boolean(pane.closest('[inert]'))),
  ).toBe(true);
  await expect.poll(() => discoveryRequests).toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath('discovery-unavailable.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('discovery-unavailable-mobile.png'),
  });

  // The next automatic check sees the original principal's existing cookie.
  expired = false;
  await expect(cover).toHaveCount(0);
  await expect
    .poll(
      async () => (await (await page.request.get(contentUrl)).json()).content,
    )
    .toBe('Retained while the session was expired');
  const unsaved = await page.evaluate(async () => {
    const canvasPath = '/src/store/canvasStore.ts';
    const { hasUnsavedCanvasEdits } = (await import(
      canvasPath
    )) as typeof CanvasModule;
    return hasUnsavedCanvasEdits();
  });
  expect(unsaved).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('cookie-recovered.png') });
});
