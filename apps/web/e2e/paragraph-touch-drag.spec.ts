// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { oneFingerDrag, openNewCanvas, touchTap } from './helpers';

import type * as CardModule from '../src/components/Messages/AIMessage/MilkdownMessageCard';
import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type * as ToolModule from '../src/store/toolStore';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';

async function expectUnchangedTextInset(page: Page, editor: Locator) {
  const layout = () =>
    editor.locator('p, li').evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        const editor = element.closest('.ProseMirror');
        if (!editor) throw new Error('Missing paragraph editor');
        return {
          left:
            Math.round(
              (bounds.left - editor.getBoundingClientRect().left) * 100,
            ) / 100,
          width: bounds.width,
        };
      }),
    );
  const touchLayout = await layout();
  for (const mode of ['mouse', 'finger'] as const) {
    await page.evaluate(async (mode) => {
      const path = '/src/store/toolStore.ts';
      const { useToolStore } = (await import(path)) as typeof ToolModule;
      useToolStore.getState().setInputModePreference(mode);
    }, mode);
    await expect(editor).toHaveAttribute(
      'contenteditable',
      String(mode === 'mouse'),
    );
    expect(await layout()).toEqual(touchLayout);
  }
}

async function emptyCanvasPoint(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) throw new Error('Missing canvas pane');
    const bounds = pane.getBoundingClientRect();
    for (const y of [0.8, 0.6, 0.4]) {
      for (const x of [0.5, 0.7, 0.3]) {
        const point = {
          x: bounds.left + bounds.width * x,
          y: bounds.top + bounds.height * y,
        };
        if (document.elementFromPoint(point.x, point.y) === pane) return point;
      }
    }
    throw new Error('No empty canvas is visible');
  });
}

test('touch Note reading, scrolling, direct paragraph extraction and explicit editing', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  const canvasId = new URL(page.url()).pathname.split('/').pop();
  if (!canvasId) throw new Error('Missing canvas ID');
  const content =
    'First paragraph.\n\nSecond **complete** paragraph.\n\n' +
    'More reading content.\n\n'.repeat(35);
  const created = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-paragraph-source',
              nodeType: 'note',
              data: { label: 'Paragraph source', content },
              position: { x: 100, y: 100 },
              size: { width: 300, height: 240 },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'paragraph-touch-test' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await page.evaluate(async () => {
    const path = '/src/store/previewWorkspace/actions.ts';
    const { openPreviewNode } = (await import(path)) as typeof PreviewActions;
    openPreviewNode('node-paragraph-source');
  });
  const editor = page.locator('.milkdown-note-preview .ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(editor).not.toBeFocused();
  await expectUnchangedTextInset(page, editor);
  const handle = page.locator(
    '.milkdown-note-preview .milkdown-touch-block-grip',
  );
  await expect(handle).toBeVisible();
  const client = await page.context().newCDPSession(page);

  const second = editor.locator('p').nth(1);
  await second.tap();
  await expect(editor).not.toBeFocused();
  const grip = await handle.boundingBox();
  if (!grip) throw new Error('Missing paragraph grip');
  expect(grip.width).toBeGreaterThanOrEqual(44);
  expect(grip.height).toBeGreaterThanOrEqual(44);
  const icon = await handle.locator('svg').boundingBox();
  if (!icon) throw new Error('Missing compact grip icon');
  expect(icon.width).toBe(16);
  expect(icon.height).toBe(16);
  expect(
    await handle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderTopWidth,
        background: style.backgroundColor,
      };
    }),
  ).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)' });
  const start = { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 };
  await touchTap(client, start);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  const target = await emptyCanvasPoint(page);
  await oneFingerDrag(client, start, target.x - start.x, target.y - start.y);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(2);
  const excerpt = page.locator(
    '.react-flow__node-note:not([data-id="node-paragraph-source"])',
  );
  await expect(excerpt.locator('.ProseMirror')).toHaveText(
    'Second complete paragraph.',
  );
  await expect(editor.locator('p')).toHaveCount(37);
  await expect(editor).not.toBeFocused();
  await expect(page.locator('.milkdown-touch-drag-preview')).toHaveCount(0);

  const scroller = editor.locator(
    'xpath=ancestor::div[contains(@class, "overflow-auto")][1]',
  );
  const box = await editor.boundingBox();
  if (!box) throw new Error('Missing reading surface');
  await oneFingerDrag(
    client,
    { x: box.x + box.width / 2, y: box.y + 250 },
    0,
    -150,
  );
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(editor).not.toBeFocused();
  await page.getByRole('button', { name: 'Edit note', exact: true }).tap();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(editor).toBeFocused();
  await page.getByRole('button', { name: 'Done editing', exact: true }).tap();
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(editor).not.toBeFocused();

  await page.reload();
  await expect(page.locator('.react-flow__node-note')).toHaveCount(2);
  await expect(
    page.locator(
      '.react-flow__node-note[data-id="node-paragraph-source"] .ProseMirror',
    ),
  ).toContainText('Second complete paragraph.');
});

test('Agent paragraph grips copy to the real Canvas without making messages editable', async ({
  page,
}) => {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const loaded = (suffix: string) => {
      const entry = performance
        .getEntriesByType('resource')
        .find((resource) => new URL(resource.name).pathname.endsWith(suffix));
      if (!entry) throw new Error(`Missing loaded module: ${suffix}`);
      return entry.name;
    };
    const cardPath =
      '/src/components/Messages/AIMessage/MilkdownMessageCard.tsx';
    const [{ default: React }, { default: ReactDOM }, { MilkdownMessageCard }] =
      await Promise.all([
        import(loaded('/deps/react.js')) as Promise<{
          default: typeof ReactModule;
        }>,
        import(loaded('/deps/react-dom_client.js')) as Promise<{
          default: typeof ReactDOMModule;
        }>,
        import(cardPath) as Promise<typeof CardModule>,
      ]);
    const host = document.createElement('div');
    host.id = 'paragraph-message-fixture';
    Object.assign(host.style, {
      position: 'fixed',
      right: '16px',
      top: '100px',
      width: '380px',
      padding: '16px',
      background: 'var(--bg-surface)',
    });
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(MilkdownMessageCard, {
        content:
          'First answer paragraph.\n\nSecond **complete** answer.\n\n- List item\n  - Nested item',
        threadId: 'paragraph-agent-test',
      }),
    );
  });
  const fixture = page.locator('#paragraph-message-fixture');
  const editor = fixture.locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expectUnchangedTextInset(page, editor);
  await expect(fixture.locator('.milkdown-preview-host')).toHaveCount(1);
  const originalParagraphCount = await editor.locator('p').count();
  await editor.locator('p').nth(1).tap();
  const handle = fixture.getByRole('button', {
    name: 'Drag paragraph to empty canvas',
  });
  const box = await handle.locator('svg').boundingBox();
  if (!box) throw new Error('Missing Agent grip');
  const paragraph = await editor.locator('p').nth(1).boundingBox();
  if (!paragraph) throw new Error('Missing Agent paragraph');
  expect(box.x + box.width).toBeLessThanOrEqual(paragraph.x);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(
    await page.evaluate(
      ({ x, y }) =>
        !!document
          .elementFromPoint(x, y)
          ?.closest('.milkdown-touch-block-grip'),
      from,
    ),
  ).toBe(true);
  const target = await emptyCanvasPoint(page);
  await page.evaluate(async () => {
    const path = '/src/store/toolStore.ts';
    const { useToolStore } = (await import(path)) as typeof ToolModule;
    useToolStore.getState().setInputModePreference('pen');
  });
  await page.getByRole('button', { name: 'Pen', exact: true }).tap();
  await expect(page.locator('[data-sketch-overlay]')).toBeVisible();
  const client = await page.context().newCDPSession(page);
  await oneFingerDrag(client, from, target.x - from.x, target.y - from.y);
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-note .ProseMirror')).toHaveText(
    'Second complete answer.',
  );
  await expect(editor.locator('p')).toHaveCount(originalParagraphCount);
  await expect(editor.locator('li')).toHaveCount(2);
  await expect(editor).not.toBeFocused();
});
