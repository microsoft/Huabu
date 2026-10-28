// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type * as QuestionModule from '../src/components/Nodes/question/questionCompose';
import type * as CanvasModule from '../src/store/canvasStore';
import type * as ChatModule from '../src/store/chatStore';
import type * as PanelModule from '../src/store/panelStore';
import type * as PreviewActions from '../src/store/previewWorkspace/actions';
import type * as PreviewModule from '../src/store/previewWorkspace/store';
import type * as ToolModule from '../src/store/toolStore';

for (const mode of ['mouse', 'touch'] as const) {
  test(`expanded Note ${mode} preview stages an attributed Comment without creating, sending or navigating`, async ({
    page,
  }) => {
    await openNewCanvas(page);
    await page.keyboard.press('Escape');
    const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
    if (!canvasId) throw new Error('Missing Space');
    const response = await page.request.post(
      `/api/canvas/${canvasId}/execute`,
      {
        data: {
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-note-comment-source',
                  nodeType: 'note',
                  data: {
                    label: 'Excerpt source',
                    content:
                      'Before **selected passage** after.\n\nSecond paragraph.',
                  },
                  position: { x: 100, y: 100 },
                },
              ],
            },
          ],
          originator: { source: 'agent', threadId: 'e2e-note-comments' },
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
    const destination = await page.evaluate(
      async ({ canvasId, mode }) => {
        const canvasPath = '/src/store/canvasStore.ts';
        const questionPath =
          '/src/components/Nodes/question/questionCompose.ts';
        const previewPath = '/src/store/previewWorkspace/actions.ts';
        const toolPath = '/src/store/toolStore.ts';
        const chatPath = '/src/store/chatStore.ts';
        const { default: canvas, awaitQuestionCreation } = (await import(
          canvasPath
        )) as typeof CanvasModule;
        const { createQuestionNode } = (await import(
          questionPath
        )) as typeof QuestionModule;
        const { openPreviewNode } = (await import(
          previewPath
        )) as typeof PreviewActions;
        const { useToolStore } = (await import(toolPath)) as typeof ToolModule;
        const { useChatStore } = (await import(chatPath)) as typeof ChatModule;
        useToolStore.getState().setInputModePreference(mode);
        const created = createQuestionNode({
          canvasId,
          addNode: canvas.getState().addNode,
          placementPoint: { x: 600, y: 100 },
          binding: { kind: 'internal' },
          mode: 'ask',
          label: 'Comment Reader',
        });
        await awaitQuestionCreation(canvasId, created.nodeId);
        useChatStore
          .getState()
          .setDraft(created.threadId, 'Keep these instructions');
        openPreviewNode('node-note-comment-source', {
          transient: false,
          focusEditor: false,
        });
        return { nodeId: created.nodeId, threadId: created.threadId };
      },
      { canvasId, mode },
    );
    const editor = page.locator('.milkdown-note-preview .ProseMirror');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute(
      'contenteditable',
      mode === 'mouse' ? 'true' : 'false',
    );
    const before = await page.evaluate(async () => {
      const previewPath = '/src/store/previewWorkspace/store.ts';
      const canvasPath = '/src/store/canvasStore.ts';
      const panelPath = '/src/store/panelStore.ts';
      const { usePreviewWorkspaceStore } = (await import(
        previewPath
      )) as typeof PreviewModule;
      const { default: canvas } = (await import(
        canvasPath
      )) as typeof CanvasModule;
      const { usePanelStore } = (await import(panelPath)) as typeof PanelModule;
      return {
        workspace: usePreviewWorkspaceStore.getState().workspace,
        nodeIds: canvas.getState().nodes.map((node) => node.id),
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
    await editor.locator('p').first().click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Comment', exact: true })
      .fill('Explain the selected claim');
    await expect(
      page.getByRole('button', { name: 'Add to input', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Add to input', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'View input', exact: true }),
    ).toBeVisible();
    await expect(editor).toBeVisible();
    const after = await page.evaluate(async ({ threadId }) => {
      const previewPath = '/src/store/previewWorkspace/store.ts';
      const canvasPath = '/src/store/canvasStore.ts';
      const panelPath = '/src/store/panelStore.ts';
      const chatPath = '/src/store/chatStore.ts';
      const { usePreviewWorkspaceStore } = (await import(
        previewPath
      )) as typeof PreviewModule;
      const { default: canvas } = (await import(
        canvasPath
      )) as typeof CanvasModule;
      const { usePanelStore } = (await import(panelPath)) as typeof PanelModule;
      const { useChatStore } = (await import(chatPath)) as typeof ChatModule;
      return {
        workspace: usePreviewWorkspaceStore.getState().workspace,
        nodeIds: canvas.getState().nodes.map((node) => node.id),
        collapsed: usePanelStore.getState().isRightCollapsed,
        viewport: document.querySelector<HTMLElement>('.react-flow__viewport')
          ?.style.transform,
        thread: useChatStore.getState().threadsById[threadId],
        focus: usePanelStore.getState().focusChatInputRequest,
      };
    }, destination);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.nodeIds).toEqual(before.nodeIds);
    expect(after.collapsed).toBe(before.collapsed);
    expect(after.viewport).toBe(before.viewport);
    expect(after.focus).toBeNull();
    expect(after.thread.draft).toBe('Keep these instructions');
    expect(after.thread.pendingQuotedComments).toMatchObject([
      {
        quote: 'Before selected passage after.',
        comment: 'Explain the selected claim',
        source: {
          kind: 'note',
          canvasId,
          nodeId: 'node-note-comment-source',
          snapshotRevision: expect.any(String),
        },
      },
    ]);
    expect(turns).toBe(0);
    await page.getByRole('button', { name: 'View input', exact: true }).click();
    const composer = page.locator('textarea[name="agent-message"]');
    await expect(composer).toHaveValue('Keep these instructions');
    await expect(composer).toBeFocused();
    await expect(
      page.locator('[data-chat-input-surface] [data-quoted-comment]'),
    ).toHaveCount(1);
    await expect(page.locator('[data-chat-input-surface]')).not.toContainText(
      'snapshotRevision',
    );
  });
}
