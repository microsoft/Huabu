// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import {
  expectSelectionToolbarOutsideSelection,
  openNewCanvas,
  readScreenshotPixels,
  editsPerCommand,
} from './helpers';

import type * as QuestionModule from '../src/components/Nodes/question/questionCompose';
import type * as ProfilesModule from '../src/store/acpProfilesStore';
import type * as CanvasModule from '../src/store/canvasStore';
import type * as ChatModule from '../src/store/chatStore';
import type * as PanelModule from '../src/store/panelStore';
import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type * as PreviewModule from '../src/store/previewWorkspace/store';
import type * as ToolModule from '../src/store/toolStore';

const sourceText = `Before selected passage after. ${'Wrapped source text. '.repeat(16)}\n\nSecond line.`;

test('Files opens visible references once and renders single-file Markdown without resource requests', async ({
  page,
}) => {
  await openNewCanvas(page);
  const markdown = [
    '# Device document',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| hello | world |',
    '',
    '```python',
    'print("hello")',
    '```',
    '',
    '![external](https://outside.invalid/image.png)',
    '![relative](./image.png)',
    '[external link](https://outside.invalid/other)',
    '[relative link](./other.md)',
    '<iframe src="https://outside.invalid/frame"></iframe>',
  ].join('\n');
  let externalRequests = 0;
  let reads = 0;
  await page.route('https://outside.invalid/**', (route) => {
    externalRequests++;
    return route.abort();
  });
  await page.route('**/api/acp/files', (route) => {
    const request = route.request().postDataJSON();
    if (request.operation === 'fs-list')
      return route.fulfill({
        json: {
          operation: 'fs-list',
          result: {
            path: '/repo',
            parentPath: '/',
            entries: [
              ...Array.from({ length: 80 }, (_, index) => {
                const name =
                  index === 0
                    ? 'README.md'
                    : `file-${String(index).padStart(3, '0')}-with-a-long-name.py`;
                return {
                  name,
                  path: `/repo/${name}`,
                  kind: index === 78 ? 'symlink' : 'file',
                };
              }),
              { name: 'z-folder', path: '/repo/z-folder', kind: 'directory' },
            ],
          },
        },
      });
    reads++;
    const text = request.args.path.endsWith('.md')
      ? markdown
      : 'greeting = "hello"';
    return route.fulfill({
      json: {
        operation: 'fs-read',
        result: {
          path: request.args.path,
          encoding: 'utf-8',
          text,
          size: Buffer.byteLength(text),
          byteLength: Buffer.byteLength(text),
          contentVersion: 'a'.repeat(64),
        },
      },
    });
  });
  await page.evaluate(async () => {
    const canvasPath = '/src/store/canvasStore.ts';
    const panelPath = '/src/store/panelStore.ts';
    const profilesPath = '/src/store/acpProfilesStore.ts';
    const { default: canvas } = (await import(
      canvasPath
    )) as typeof CanvasModule;
    const { usePanelStore } = (await import(panelPath)) as typeof PanelModule;
    const { useAcpProfilesStore } = (await import(
      profilesPath
    )) as typeof ProfilesModule;
    useAcpProfilesStore.setState({
      refresh: async () => {},
      connectedDevices: [
        {
          agentletId: 'device-files',
          displayName: 'Test device',
          connectedAt: '',
          version: '1',
          profileCount: 0,
        },
      ],
    });
    usePanelStore.getState().openFiles({
      canvasId: canvas.getState().canvasId,
      agentletId: 'device-files',
      path: '/repo',
    });
  });
  const files = page.getByRole('region', { name: 'Files', exact: true });
  const folder = files.getByRole('button', { name: 'z-folder', exact: true });
  await expect(files.locator('[data-file-index="0"]')).toHaveText('z-folder');
  const first = files.getByRole('button', {
    name: 'Open README.md (adds a reference if needed)',
    exact: true,
  });
  await first.click();
  await expect(page.locator('.react-flow__node-fileReference')).toHaveCount(0);
  await first.dblclick();
  await expect(page.locator('.react-flow__node-fileReference')).toHaveCount(1);
  const reading = page.getByRole('textbox', {
    name: 'Read-only Markdown file',
  });
  await expect(reading).toBeVisible();
  await expect(reading.getByRole('table')).toContainText('hello');
  await expect(reading).toContainText('print("hello")');
  await expect(
    reading.locator('img[src], img[srcset], a[href], iframe'),
  ).toHaveCount(0);
  const initialReads = reads;
  await first.dblclick();
  await expect(page.locator('.react-flow__node-fileReference')).toHaveCount(1);
  expect(reads).toBe(initialReads);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Read-only file source' }),
  ).toContainText('# Device document');
  await first.focus();
  await first.press('End');
  const last = files.getByRole('button', {
    name: 'Open file-079-with-a-long-name.py (adds a reference if needed)',
    exact: true,
  });
  await expect(last).toBeFocused();
  await last.press('ArrowUp');
  const previous = files.getByRole('button', {
    name: 'Open file-077-with-a-long-name.py (adds a reference if needed)',
    exact: true,
  });
  await expect(previous).toBeFocused();
  await previous.press('ArrowDown');
  await expect(last).toBeFocused();
  await last.press('Enter');
  await expect(page.locator('.react-flow__node-fileReference')).toHaveCount(2);
  await expect(
    page.getByRole('textbox', { name: 'Read-only file source' }),
  ).toContainText('greeting');
  await last.press('Home');
  await expect(folder).toBeFocused();
  await folder.press('ArrowDown');
  await expect(first).toBeFocused();
  await first.press('End');
  await expect(last).toBeFocused();
  await last.press('Home');
  await expect(folder).toBeFocused();
  await folder.press('ArrowDown');
  await expect(first).toBeFocused();
  await first.press('Shift+F10');
  await page
    .getByRole('menuitem', { name: 'Add to Space', exact: true })
    .click();
  await expect(page.locator('.react-flow__node-fileReference')).toHaveCount(3);
  expect(externalRequests).toBe(0);
  const references = await page.evaluate(async () => {
    const canvasPath = '/src/store/canvasStore.ts';
    const { default: canvas } = (await import(
      canvasPath
    )) as typeof CanvasModule;
    return canvas
      .getState()
      .nodes.filter((node) => node.type === 'fileReference');
  });
  expect(
    references.every((node) => !node.hidden && node.data.content === undefined),
  ).toBe(true);
});

for (const mode of ['mouse', 'touch'] as const) {
  test(`file preview ${mode} stages a frozen partial-file Comment without a read, send or navigation`, async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    let reads = 0;
    await page.route('**/api/acp/files', async (route) => {
      reads++;
      expect(route.request().postDataJSON()).toMatchObject({
        agentletId: 'source-device',
        operation: 'fs-read',
        args: { path: '/source.tex' },
      });
      await route.fulfill({
        json: {
          operation: 'fs-read',
          result: {
            path: '/canonical/source.tex',
            text: sourceText,
            encoding: 'utf-8',
            byteLength: sourceText.length,
            size: 400_000,
            contentVersion: 'a'.repeat(64),
            nextCursor: 'more',
          },
        },
      });
    });
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    if (!canvasId) throw new Error('Missing Space');
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          edits: editsPerCommand([
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-file-source',
                  nodeType: 'fileReference',
                  data: {
                    label: 'Source file',
                    fileReference: {
                      agentletId: 'source-device',
                      path: '/source.tex',
                    },
                  },
                  position: { x: 100, y: 100 },
                },
              ],
            },
          ]),
          originator: { source: 'agent', threadId: 'e2e-file-comments' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('.react-flow__node-fileReference')).toHaveCount(
      1,
    );
    const destination = await page.evaluate(
      async ({ canvasId, mode }) => {
        const canvasPath = '/src/store/canvasStore.ts';
        const questionPath =
          '/src/components/Nodes/question/questionCompose.ts';
        const previewPath = '/src/store/previewWorkspace/actions.ts';
        const chatPath = '/src/store/chatStore.ts';
        const toolPath = '/src/store/toolStore.ts';
        const { default: canvas, awaitQuestionCreation } = (await import(
          canvasPath
        )) as typeof CanvasModule;
        const { createQuestionNode } = (await import(
          questionPath
        )) as typeof QuestionModule;
        const { openPreviewNode } = (await import(
          previewPath
        )) as typeof PreviewActions;
        const { useChatStore } = (await import(chatPath)) as typeof ChatModule;
        const { useToolStore } = (await import(toolPath)) as typeof ToolModule;
        useToolStore.getState().setInputModePreference(mode);
        const created = createQuestionNode({
          canvasId,
          addNode: canvas.getState().addNode,
          placementPoint: { x: 600, y: 100 },
          binding: { kind: 'internal' },
          mode: 'ask',
          label: 'File Reader',
        });
        await awaitQuestionCreation(canvasId, created.nodeId);
        useChatStore.getState().setDraft(created.threadId, 'Keep instructions');
        openPreviewNode('node-file-source', {
          transient: false,
          focusEditor: false,
        });
        return created;
      },
      { canvasId, mode },
    );
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible();
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    const initialReads = reads;
    const before = await page.evaluate(async () => {
      const previewPath = '/src/store/previewWorkspace/store.ts';
      const panelPath = '/src/store/panelStore.ts';
      const { usePreviewWorkspaceStore } = (await import(
        previewPath
      )) as typeof PreviewModule;
      const { usePanelStore } = (await import(panelPath)) as typeof PanelModule;
      return {
        workspace: usePreviewWorkspaceStore.getState().workspace,
        collapsed: usePanelStore.getState().isRightCollapsed,
        viewport: document.querySelector<HTMLElement>('.react-flow__viewport')
          ?.style.transform,
      };
    });
    let turns = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/agent(?:\?|$)/.test(request.url())
      )
        turns++;
    });
    const selectPassage = async () => {
      const line = editor.locator('.cm-line').first();
      if (mode === 'touch') {
        await line.tap();
        // Let CodeMirror finish the tap's selection sync before simulating native touch handles.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            }),
        );
        await line.evaluate((element) => {
          const text = element.firstChild;
          if (!text) throw new Error('Missing source text');
          const range = document.createRange();
          range.setStart(text, 7);
          range.setEnd(text, 23);
          const selection = window.getSelection();
          if (!selection) throw new Error('Missing document selection');
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
        });
      } else {
        const points = await line.evaluate((element) => {
          const text = element.firstChild;
          if (!text) throw new Error('Missing source text');
          const point = (offset: number) => {
            const range = document.createRange();
            range.setStart(text, offset);
            range.collapse(true);
            const rect = range.getBoundingClientRect();
            return { x: rect.x, y: rect.y + rect.height / 2 };
          };
          return { from: point(7), to: point(23) };
        });
        await page.mouse.move(points.from.x, points.from.y);
        await page.mouse.down();
        await page.mouse.move(points.to.x, points.to.y, { steps: 8 });
        await expect(page.locator('.selection-context-toolbar')).toHaveCount(0);
        await page.mouse.up();
      }
      await expect(
        page.getByRole('button', { name: 'Comment', exact: true }),
      ).toBeVisible();
    };
    await selectPassage();
    await expectSelectionToolbarOutsideSelection(page);
    const capsules = page.locator(
      '.selection-context-toolbar .canvas-context-toolbar',
    );
    await expect(capsules).toHaveCount(2);
    for (const capsule of await capsules.all()) {
      await expect(capsule).toHaveCSS('height', '36px');
      await expect(capsule).toHaveCSS('border-radius', '8px');
    }
    await page.screenshot({
      path: testInfo.outputPath('file-selection-toolbar.png'),
      animations: 'disabled',
    });
    await expect(
      page.getByRole('button', { name: 'Copy', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add as note', exact: true }),
    ).toBeVisible();
    const paint = await editor.evaluate((content) => {
      const line = content.querySelector('.cm-activeLine');
      const shell = content.closest('.cm-editor');
      const selection = shell?.querySelector('.cm-selectionBackground');
      if (!line || !selection)
        throw new Error('Missing active line or drawn selection');
      const rect = selection.getBoundingClientRect();
      const style = getComputedStyle(line);
      return {
        lineBackground: style.backgroundColor,
        lineHeight: line.getBoundingClientRect().height,
        textLineHeight: Number.parseFloat(style.lineHeight),
        backgroundLayer: getComputedStyle(line, '::before').zIndex,
        point: { x: rect.x + rect.width / 2, y: rect.bottom - 2 },
      };
    });
    expect(paint.lineHeight).toBeGreaterThan(paint.textLineHeight * 2);
    expect(paint.lineBackground).toBe('rgba(0, 0, 0, 0)');
    expect(paint.backgroundLayer).toBe('-2');
    const [pixel] = await readScreenshotPixels(page, [paint.point]);
    expect(pixel[2] - pixel[0]).toBeGreaterThan(5);
    await page.screenshot({
      path: test.info().outputPath(`file-selection-${mode}.png`),
    });
    await editor.evaluate((content) => content.blur());
    await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-focused/);
    const [unfocusedPixel] = await readScreenshotPixels(page, [paint.point]);
    expect(unfocusedPixel[2] - unfocusedPixel[0]).toBeGreaterThan(5);
    const copy = page.getByRole('button', { name: 'Copy', exact: true });
    if (mode === 'touch') await copy.tap();
    else await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('selected passage');
    await expect(copy).toBeHidden();
    await selectPassage();
    const save = page.getByRole('button', { name: 'Add as note', exact: true });
    if (mode === 'touch') await save.tap();
    else await save.click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const canvasPath = '/src/store/canvasStore.ts';
          const { default: canvas } = (await import(
            canvasPath
          )) as typeof CanvasModule;
          return canvas
            .getState()
            .nodes.filter(
              (node) =>
                node.type === 'note' &&
                node.data.content === 'selected passage',
            )
            .map((node) => node.data.origin);
        }),
      )
      .toEqual([
        { type: 'user-excerpt', excerptFromNodeId: 'node-file-source' },
      ]);
    await selectPassage();
    const comment = page.getByRole('button', { name: 'Comment', exact: true });
    if (mode === 'touch') await comment.tap();
    else await comment.click();
    await expect(
      page.getByText('Captured file snapshot', { exact: false }),
    ).toContainText('/canonical/source.tex');
    await page
      .getByRole('textbox', { name: 'Comment', exact: true })
      .fill('Explain the file');
    const add = page.getByRole('button', { name: 'Add to input', exact: true });
    await expect(add).toBeEnabled();
    if (mode === 'touch') await add.tap();
    else await add.click();
    await expect(
      page.getByRole('button', { name: 'View input', exact: true }),
    ).toBeVisible();
    const after = await page.evaluate(async ({ threadId }) => {
      const previewPath = '/src/store/previewWorkspace/store.ts';
      const panelPath = '/src/store/panelStore.ts';
      const chatPath = '/src/store/chatStore.ts';
      const { usePreviewWorkspaceStore } = (await import(
        previewPath
      )) as typeof PreviewModule;
      const { usePanelStore } = (await import(panelPath)) as typeof PanelModule;
      const { useChatStore } = (await import(chatPath)) as typeof ChatModule;
      return {
        workspace: usePreviewWorkspaceStore.getState().workspace,
        collapsed: usePanelStore.getState().isRightCollapsed,
        viewport: document.querySelector<HTMLElement>('.react-flow__viewport')
          ?.style.transform,
        focus: usePanelStore.getState().focusChatInputRequest,
        thread: useChatStore.getState().threadsById[threadId],
      };
    }, destination);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.collapsed).toBe(before.collapsed);
    expect(after.viewport).toBe(before.viewport);
    expect(after.focus).toBeNull();
    expect(after.thread.draft).toBe('Keep instructions');
    expect(after.thread.pendingQuotedComments).toMatchObject([
      {
        quote: 'selected passage',
        comment: 'Explain the file',
        source: {
          kind: 'file-reference',
          canvasId,
          nodeId: 'node-file-source',
          agentletId: 'source-device',
          path: '/canonical/source.tex',
          contentVersion: 'a'.repeat(64),
          offsetUnit: 'utf-16',
          complete: false,
          loadedLength: sourceText.length,
        },
      },
    ]);
    expect(reads).toBe(initialReads);
    expect(turns).toBe(0);
    expect(pageErrors).toEqual([]);
    await page.getByRole('button', { name: 'View input', exact: true }).click();
    const composer = page.locator('textarea[name="agent-message"]');
    await expect(composer).toHaveValue('Keep instructions');
    await expect(composer).toBeFocused();
    await expect(
      page.locator('[data-chat-input-surface] [data-quoted-comment]'),
    ).toHaveCount(1);
    await expect(page.locator('[data-chat-input-surface]')).not.toContainText(
      'contentVersion',
    );

    const other = await page.evaluate(async (canvasId) => {
      const canvasPath = '/src/store/canvasStore.ts';
      const questionPath = '/src/components/Nodes/question/questionCompose.ts';
      const actionsPath = '/src/store/previewWorkspace/actions.ts';
      const { default: canvas, awaitQuestionCreation } = (await import(
        canvasPath
      )) as typeof CanvasModule;
      const { createQuestionNode } = (await import(
        questionPath
      )) as typeof QuestionModule;
      const { openPreviewNode } = (await import(
        actionsPath
      )) as typeof PreviewActions;
      const created = createQuestionNode({
        canvasId,
        addNode: canvas.getState().addNode,
        placementPoint: { x: 1000, y: 100 },
        binding: { kind: 'internal' },
        mode: 'ask',
        label: 'Other reader',
      });
      await awaitQuestionCreation(canvasId, created.nodeId);
      openPreviewNode(created.nodeId, { transient: false });
      return created;
    }, canvasId);
    await page.getByRole('tab', { name: /Other reader/ }).click();
    await page.getByRole('tab', { name: /Source file/ }).click();
    await selectPassage();
    await comment.click();
    await expect(
      page.getByRole('button', { name: 'File Reader', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Comment', exact: true })
      .fill('Another passage');
    await add.click();
    await expect
      .poll(() =>
        page.evaluate(async (threadId) => {
          const chatPath = '/src/store/chatStore.ts';
          const { useChatStore } = (await import(
            chatPath
          )) as typeof ChatModule;
          return useChatStore
            .getState()
            .threadsById[
              threadId
            ].pendingQuotedComments.map((item) => item.comment);
        }, destination.threadId),
      )
      .toEqual(['Explain the file', 'Another passage']);
    await selectPassage();
    await comment.click();
    await page
      .getByRole('button', { name: 'File Reader', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Other reader', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Comment', exact: true })
      .fill('Explicit switch');
    await add.click();
    await expect
      .poll(() =>
        page.evaluate(async (threadId) => {
          const chatPath = '/src/store/chatStore.ts';
          const { useChatStore } = (await import(
            chatPath
          )) as typeof ChatModule;
          return useChatStore
            .getState()
            .threadsById[
              threadId
            ]?.pendingQuotedComments.map((item) => item.comment);
        }, other.threadId),
      )
      .toEqual(['Explicit switch']);
    expect(turns).toBe(0);
    expect(pageErrors).toEqual([]);
  });
}
