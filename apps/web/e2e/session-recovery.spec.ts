// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as CanvasModule from '../src/store/canvasStore';
import type * as OidcModule from '../src/utils/oidcLogin';

for (const currentPeerRemains of [true, false]) {
  test(`does not reuse a rotated token after a tab reload (current peer: ${currentPeerRemains})`, async ({
    context,
    page,
  }) => {
    // Keep browser storage, channels, locks and the OIDC module real. Only
    // the provider and the document's delayed module startup are fixtures.
    await context.route('**/session-rotation-probe', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
    );
    const presented: string[] = [];
    let currentToken = 'refresh-1';
    let familyRevoked = false;
    await context.route('https://auth.example/**', (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (route.request().url().endsWith('openid-configuration'))
        return route.fulfill({
          headers,
          json: { token_endpoint: 'https://auth.example/token' },
        });
      const grant = new URLSearchParams(route.request().postData() ?? '');
      if (grant.get('grant_type') === 'refresh_token') {
        const token = grant.get('refresh_token') ?? '';
        presented.push(token);
        if (familyRevoked || token !== currentToken) {
          familyRevoked = true;
          return route.fulfill({
            status: 400,
            headers,
            json: { error: 'invalid_grant' },
          });
        }
        currentToken = `refresh-${presented.length + 1}`;
      }
      return route.fulfill({
        headers,
        json: {
          access_token: 'fixture-access',
          refresh_token: currentToken,
          expires_in: 3600,
        },
      });
    });

    await page.goto('/session-rotation-probe');
    await page.evaluate(async () => {
      const modulePath = '/src/utils/oidcLogin.ts';
      const oidc = (await import(modulePath)) as typeof OidcModule;
      sessionStorage.setItem(
        'huabu.oidc.pending',
        JSON.stringify({
          state: 'rotation-probe',
          verifier: 'fixture-verifier',
          returnTo: '/session-rotation-probe',
          authenticator: {
            driver: 'auth0',
            issuer: 'https://auth.example',
            authorizationUrl: 'https://auth.example/authorize',
            clientId: 'fixture-spa',
            scopes: ['openid'],
          },
        }),
      );
      history.replaceState(
        null,
        '',
        '/auth/callback?state=rotation-probe&code=fixture-code',
      );
      await oidc.completeLogin();
    });
    const reloadingTab = await context.newPage();
    await reloadingTab.goto('/session-rotation-probe');
    await reloadingTab.evaluate(async () => {
      const modulePath = '/src/utils/oidcLogin.ts';
      await import(modulePath);
    });
    await expect
      .poll(() =>
        reloadingTab.evaluate(() =>
          sessionStorage.getItem('huabu.oidc.refresh'),
        ),
      )
      .toContain('refresh-1');

    // B misses A's rotation while its replacement document is loading.
    await reloadingTab.reload();
    const renew = async () => {
      const modulePath = '/src/utils/oidcLogin.ts';
      const oidc = (await import(modulePath)) as typeof OidcModule;
      return Boolean(await oidc.refreshTokens());
    };
    expect(await page.evaluate(renew)).toBe(true);
    expect(presented).toEqual(['refresh-1']);
    if (!currentPeerRemains) await page.close();

    expect(await reloadingTab.evaluate(renew)).toBe(currentPeerRemains);
    if (currentPeerRemains) {
      expect(await page.evaluate(renew)).toBe(true);
      expect(presented).toEqual(['refresh-1', 'refresh-2', 'refresh-3']);
    } else {
      // Without a current peer, require sign-in instead of risking the family.
      expect(presented).toEqual(['refresh-1']);
    }
    expect(familyRevoked).toBe(false);
    expect(
      await reloadingTab.evaluate(() => JSON.stringify(localStorage)),
    ).not.toContain('refresh-');
    await reloadingTab.close();
  });
}

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
