// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as CanvasStore from '../src/store/canvasStore';
import type * as ChatStore from '../src/store/chatStore';
import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type * as WorkspaceStore from '../src/store/previewWorkspace/store';

test.use({ hasTouch: false, viewport: { width: 1600, height: 1000 } });

test('Chat status overlays its icon, shares the tab tooltip and retains visible error recovery', async ({
  page,
}) => {
  let failMetadata = true;
  let metadataReads = 0;
  await page.route('**/api/acp/threads/*/cached-meta**', (route) => {
    metadataReads += 1;
    return failMetadata
      ? route.fulfill({ status: 503, json: { message: 'Cache unavailable' } })
      : route.fulfill({
          json: {
            source: 'thread',
            sessionMeta: {
              availableModes: [],
              currentModeId: null,
              availableModels: [],
              currentModelId: null,
              configOptions: [],
              selections: {},
              sessionInfo: null,
              usage: null,
              updatedAt: 1,
            },
          },
        });
  });
  await openNewCanvas(page);
  await page.evaluate(async () => {
    const canvasPath = '/src/store/canvasStore.ts';
    const chatPath = '/src/store/chatStore.ts';
    const actionsPath = '/src/store/previewWorkspace/actions.ts';
    const [{ default: canvas }, { useChatStore }, { openPreviewNode }] =
      await Promise.all([
        import(canvasPath) as Promise<typeof CanvasStore>,
        import(chatPath) as Promise<typeof ChatStore>,
        import(actionsPath) as Promise<typeof PreviewActions>,
      ]);
    useChatStore.getState().setHistoryLoaded('status-thread', true);
    canvas.setState({
      nodes: [
        {
          id: 'status-question',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {
            label: 'Status question',
            labelSource: 'user',
            threadId: 'status-thread',
            status: 'done',
            bindingState: 'bound',
            agentBinding: {
              kind: 'external',
              profileId: 'status-profile',
              alias: 'Status Agent',
            },
          },
        },
        {
          id: 'status-note',
          type: 'text',
          position: { x: 400, y: 0 },
          data: { label: 'Ordinary text', content: 'No Agent status here' },
        },
      ],
    });
    openPreviewNode('status-question', { transient: false });
  });
  const tab = page.getByRole('tab', {
    name: 'Status question (question)',
    exact: true,
  });
  const panel = page.getByRole('tabpanel');
  const dot = tab.locator('[data-acp-connection-status]');
  await expect(dot).toHaveAttribute('data-acp-connection-status', 'failed');
  await expect(panel.locator('[data-acp-connection-status]')).toHaveCount(0);
  await expect(panel.locator('[data-preview-active="true"] .h-9')).toHaveCount(
    0,
  );
  const alert = panel
    .getByRole('alert')
    .filter({ hasText: 'Cache unavailable' });
  await expect(alert).toBeVisible();
  const initialReads = metadataReads;
  await tab.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toContainText('Load failed');
  await expect(tooltip).not.toContainText('Status Agent');
  await expect(tooltip).not.toContainText('Cache unavailable');
  expect(metadataReads).toBe(initialReads);
  const iconBox = await tab.getByTestId('preview-tab-icon').boundingBox();
  const dotBox = await dot.boundingBox();
  if (!iconBox || !dotBox) throw new Error('Status icon must be measurable');
  expect(dotBox.width).toBe(6);
  expect(dotBox.height).toBe(6);
  expect(dotBox.x).toBeGreaterThan(iconBox.x + iconBox.width / 2);
  expect(dotBox.y).toBeGreaterThan(iconBox.y + iconBox.height / 2);
  expect(dotBox.x + dotBox.width).toBeCloseTo(iconBox.x + iconBox.width + 2, 0);
  expect(dotBox.y + dotBox.height).toBeCloseTo(
    iconBox.y + iconBox.height + 2,
    0,
  );
  failMetadata = false;
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dot).toHaveAttribute('data-acp-connection-status', 'connected');
  await expect(alert).toHaveCount(0);
  expect(metadataReads).toBe(initialReads + 1);
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  await tab.focus();
  await expect(tooltip).toContainText('Normal');
  await expect(tooltip.getByTestId('preview-tooltip-meta')).toContainText(
    'Normal',
  );
  await expect(tooltip.getByTestId('preview-tooltip-title')).toHaveText(
    'Status question',
  );
  await expect(tooltip).not.toContainText('Status Agent');
  await expect(tooltip).not.toContainText('live connection');
  await expect(tooltip).toContainText('Status question');
  await expect(tab).toHaveAttribute('aria-describedby', /.+/);

  await page.evaluate(async () => {
    const path = '/src/store/previewWorkspace/actions.ts';
    const { openPreviewNode } = (await import(path)) as typeof PreviewActions;
    openPreviewNode('status-note', { transient: false });
  });
  await expect(
    page.getByRole('tab', { name: 'Ordinary text (text)', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.locator('[role="tab"] [data-acp-connection-status]'),
  ).toHaveCount(0);
  await tab.click();
  await expect(dot).toHaveAttribute('data-acp-connection-status', 'connected');
});

test('tab-owned titles retain content actions and durable rename without duplicate title chrome', async ({
  page,
}) => {
  await openNewCanvas(page);
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              data: {
                label: 'Alpha title',
                labelSource: 'user',
                content: 'Note body',
              },
              position: { x: 0, y: 0 },
              size: { width: 300, height: 200 },
            },
            {
              nodeType: 'text',
              data: {
                label: 'Beta title',
                labelSource: 'user',
                content: 'Text body',
              },
              position: { x: 400, y: 0 },
              size: { width: 300, height: 200 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-preview-title-rename' },
    },
  });

  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-text')).toHaveCount(1);
  await page.evaluate(async () => {
    const storePath = '/src/store/canvasStore.ts';
    const actionsPath = '/src/store/previewWorkspace/actions.ts';
    const [{ default: canvasStore }, { openPreviewNode }] = await Promise.all([
      import(storePath) as Promise<typeof CanvasStore>,
      import(actionsPath) as Promise<typeof PreviewActions>,
    ]);
    const nodes = canvasStore.getState().nodes;
    const note = nodes.find((node) => node.type === 'note');
    const text = nodes.find((node) => node.type === 'text');
    if (!note || !text) throw new Error('Preview fixture nodes are missing');
    openPreviewNode(note.id, { transient: false });
    openPreviewNode(text.id, { transient: false });
  });
  const alpha = page.getByRole('tab', {
    name: 'Alpha title (note)',
    exact: true,
  });
  const beta = page.getByRole('tab', {
    name: 'Beta title (text)',
    exact: true,
  });
  const panel = page.getByRole('tabpanel');
  const header = panel
    .locator('[data-preview-active="true"]')
    .getByTestId('expanded-node-header');
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  await expect(
    panel.getByRole('button', { name: 'Rename node', exact: true }),
  ).toHaveCount(0);
  await expect(header).toBeHidden();
  await beta.focus();
  await beta.press('F2');
  const input = page.getByRole('tab').getByRole('textbox', {
    name: 'Rename node',
    exact: true,
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Beta title');
  await expect(header).toBeHidden();
  await expect(beta.getByRole('textbox')).toBeFocused();
  await input.press('Escape');
  await expect(beta).toBeFocused();
  await expect(header).toBeHidden();

  await beta.press('Shift+F10');
  await expect(
    page.getByRole('menuitem', { name: /Rename node/ }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(beta).toBeFocused();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await alpha.click({ button: 'right' });
  const rename = page.getByRole('menuitem', { name: /Rename node/ });
  await expect(rename).toBeFocused();
  await expect(page.getByRole('menuitem').locator('svg')).toHaveCount(0);
  const tabBounds = await alpha.boundingBox();
  const menuBounds = await page.getByRole('menu').boundingBox();
  if (!tabBounds || !menuBounds) throw new Error('Missing tab menu geometry');
  expect(menuBounds.y).toBeGreaterThanOrEqual(tabBounds.y + tabBounds.height);
  expect(menuBounds.y - tabBounds.y - tabBounds.height).toBeLessThan(20);
  expect(Math.abs(menuBounds.x - tabBounds.x)).toBeLessThan(12);
  await rename.click();
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Alpha title');
  await input.fill('Durable new title');
  await input.press('Enter');
  const renamed = page.getByRole('tab', {
    name: 'Durable new title (note)',
    exact: true,
  });
  await expect(renamed).toBeFocused();
  await expect(input).toHaveCount(0);
  await expect(header).toBeVisible();
  await expect(
    header.locator('[data-preview-header-actions] button'),
  ).not.toHaveCount(0);
  await expect(header).not.toContainText('Durable new title');
  await header
    .getByRole('button', { name: 'Switch to raw markdown editor' })
    .click();
  await expect(
    header.getByRole('button', { name: 'Switch to rich text editor' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('tab', { name: 'Durable new title (note)', exact: true }),
  ).toBeVisible();
});

test('Web and PDF summaries share their real content toolbar and do not move the document', async ({
  page,
}) => {
  await page.route('https://preview.example.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><h1>Local web fixture</h1></body></html>',
    }),
  );
  await page.route('**/api/web/page?**', (route) =>
    route.fulfill({
      json: {
        kind: 'url',
        src: 'https://preview.example.test/',
        embeddable: true,
      },
    }),
  );
  await openNewCanvas(page);
  await page.evaluate(async () => {
    const canvasPath = '/src/store/canvasStore.ts';
    const workspacePath = '/src/store/previewWorkspace/store.ts';
    const actionsPath = '/src/store/previewWorkspace/actions.ts';
    const [
      { default: canvas },
      { usePreviewWorkspaceStore },
      { openPreviewNode },
    ] = await Promise.all([
      import(canvasPath) as Promise<typeof CanvasStore>,
      import(workspacePath) as Promise<typeof WorkspaceStore>,
      import(actionsPath) as Promise<typeof PreviewActions>,
    ]);
    const canvasId = canvas.getState().canvasId;
    canvas.setState({
      nodes: [
        {
          id: 'web-fixture',
          type: 'web',
          position: { x: 0, y: 0 },
          data: {
            label: 'Web fixture',
            labelSource: 'user',
            src: 'https://preview.example.test/',
            summary: 'Web summary content',
            keywords: ['Web keyword'],
          },
        },
        {
          id: 'pdf-fixture',
          type: 'pdf',
          position: { x: 450, y: 0 },
          data: {
            label: 'PDF fixture',
            labelSource: 'user',
            src: '',
            summary: 'PDF summary content',
            keywords: ['PDF keyword'],
          },
        },
      ],
      edges: [],
    });
    openPreviewNode('web-fixture', { transient: false });
    usePreviewWorkspaceStore
      .getState()
      .openPreviewTarget(
        { kind: 'node', nodeId: 'pdf-fixture', canvasId },
        { openToSide: true },
      );
  });
  await expect(page.getByRole('tabpanel')).toHaveCount(2);
  const web = page.getByRole('tabpanel').nth(0);
  const pdf = page.getByRole('tabpanel').nth(1);
  await expect(
    web.getByRole('button', { name: 'Reload page', exact: true }),
  ).toBeVisible();
  await expect(
    web.getByRole('button', {
      name: 'Open page in external browser',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    pdf.getByRole('button', { name: 'Select area to capture', exact: true }),
  ).toBeVisible();
  await expect(
    pdf.getByRole('button', { name: 'Highlight Text', exact: true }),
  ).toBeVisible();
  for (const [index, name] of ['Web', 'PDF'].entries()) {
    const panel = page.getByRole('tabpanel').nth(index);
    const header = panel.getByTestId('expanded-node-header');
    await expect(header).toHaveCount(1);
    const summary = header.getByRole('button', {
      name: 'AI Summary',
      exact: true,
    });
    await expect(summary).toHaveText('');
    await summary.click({ trial: true });
    const body = panel.locator('[data-search-scope="node"] > div').last();
    const before = await body.boundingBox();
    await summary.click();
    const dialog = page.getByRole('dialog', {
      name: 'AI Summary',
      exact: true,
    });
    await expect(dialog).toContainText(`${name} summary content`);
    await expect(dialog).toContainText(`${name} keyword`);
    expect(await body.boundingBox()).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(summary).toBeFocused();
    await summary.click();
    await dialog.getByRole('button', { name: 'Close AI summary' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(summary).toBeVisible();
  }
});
