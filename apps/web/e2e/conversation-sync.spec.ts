// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import { installStreams, publish } from './stream-helpers';

import type {
  AgentConversationOwnerEvent,
  AgentHistoryDisplayTurn,
  AgentStreamEvent,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

for (const direction of ['parent-to-child', 'child-to-parent']) {
  test(`synchronizes live conversation ${direction} without losing a stream on node updates`, async ({
    context,
    page,
    request,
  }, testInfo) => {
    const parent = (
      await (
        await request.post('/api/canvas', {
          data: { title: `Sync parent ${direction}` },
        })
      ).json()
    ).canvasId as string;
    const childResponse = await request.post(`/api/canvas/${parent}/children`, {
      data: { title: `Sync child ${direction}`, position: { x: 100, y: 100 } },
    });
    expect(childResponse.ok()).toBe(true);
    const parentState = await (
      await request.get(`/api/canvas/${parent}`)
    ).json();
    const child = parentState.state.nodes.find(
      (node: CanvasNode) => node.type === 'spacePreview',
    )?.data.targetCanvasId as string;
    expect(child).toBeTruthy();
    const creation = await request.post(`/api/canvas/${child}/execute`, {
      data: {
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-sync-agent',
                nodeType: 'question',
                position: { x: 100, y: 100 },
                data: {
                  label: 'Sync conversation',
                  content: 'Initial question',
                  agentBinding: { kind: 'internal' },
                },
              },
            ],
          },
        ],
        originator: { source: 'ui' },
      },
    });
    expect(creation.ok()).toBe(true);
    const association = await request.post(
      `/api/canvas/${child}/nodes/node-sync-agent/association`,
      {
        data: { kind: 'initialize' },
      },
    );
    expect(association.ok()).toBe(true);
    const initial = await (await request.get(`/api/canvas/${child}`)).json();
    let node = initial.state.nodes.find(
      (item: CanvasNode) => item.id === 'node-sync-agent',
    ) as CanvasNode;
    const threadId = node.data.threadId as string;
    let version = initial.version as number;
    let status: 'idle' | 'running' | 'done' = 'idle';
    const turns: AgentHistoryDisplayTurn[] = [
      {
        id: 'old',
        messages: [
          { role: 'user', content: 'Initial question' },
          {
            role: 'assistant',
            parts: [{ kind: 'text', text: 'Previous response' }],
          },
        ],
      },
    ];
    const childPage = await context.newPage();
    await Promise.all([installStreams(page), installStreams(childPage)]);
    const sender = direction === 'parent-to-child' ? page : childPage;
    const observer = direction === 'parent-to-child' ? childPage : page;
    let observerAttachments = 0;
    let submitted: Record<string, unknown> | undefined;
    const streamKey = `thread:${threadId}`;
    const canvasKey = `canvas:${child}`;
    const ownerKey = `owner:${threadId}`;
    let ownerMissing = false;
    let ownerReads = 0;
    let ownerRevision = 1;
    const ownerSnapshot = (): AgentConversationOwnerEvent => ({
      type: 'snapshot',
      data: {
        streamId: 'test-state-stream',
        revision: ownerRevision,
        value: ownerMissing
          ? {
              state: 'unavailable',
              status: 404,
              error: {
                code: 'conversation_owner_missing',
                message: 'Owner missing',
              },
            }
          : {
              state: 'ready',
              owner: {
                canvasId: child,
                nodeId: node.id,
                threadId,
                spaceTitle: `Sync child ${direction}`,
                source: {
                  ...node.data,
                  hasAuthoredContent: true,
                  agentBinding: { kind: 'internal' },
                },
              },
            },
      },
    });
    const partial: AgentStreamEvent = {
      type: 'text_delta',
      data: { content: 'Live cross-Space reply' },
    };
    const project = async (patch: Record<string, unknown>) => {
      ownerRevision++;
      const previous = node;
      node = { ...node, data: { ...node.data, ...patch } };
      const event = {
        type: 'update' as const,
        data: {
          fromVersion: version,
          toVersion: ++version,
          deltas: [{ type: 'REPLACE_NODE', prev: previous, next: node }],
          pendingEffects: {
            mutatedNodes: [node],
            deletedNodeIds: [],
            contentEditedNodeIds: [],
            deferredFitFrameIds: [],
          },
          agentNodeProjection: true,
        },
      };
      await Promise.all([
        publish(childPage, canvasKey, event),
        publish(page, canvasKey, event),
        publish(childPage, ownerKey, ownerSnapshot()),
        publish(page, ownerKey, ownerSnapshot()),
      ]);
    };
    await context.route('**/api/canvas/cards/query', (route) =>
      route.fulfill({
        json: {
          spaces: {
            [child]: {
              status: 'ready',
              canvasId: child,
              title: `Sync child ${direction}`,
              updatedAt: Date.now(),
              activity: [
                {
                  nodeId: node.id,
                  threadId,
                  title: 'Sync conversation',
                  status: 'unread',
                  agentBinding: { kind: 'internal' },
                },
              ],
            },
          },
        },
      }),
    );
    await context.route(`**/api/canvas/${child}/sync/stream`, (route) => {
      return route.fulfill({
        headers: { 'x-test-stream': 'true' },
        json: {
          key: canvasKey,
          events: [{ type: 'snapshot', data: { version } }],
        },
      });
    });
    await context.route(
      `**/api/canvas/${child}/nodes/${node.id}/viewed`,
      (route) => route.fulfill({ json: { acknowledged: true } }),
    );
    let sendCount = 0;
    await context.route(`**/api/agent/owner/${threadId}/stream?**`, (route) =>
      route.fulfill({
        headers: { 'x-test-stream': 'true' },
        json: { key: ownerKey, events: [ownerSnapshot()] },
      }),
    );
    await context.route(`**/api/agent/owner/${threadId}?**`, (route) => {
      ownerReads++;
      return ownerMissing
        ? route.fulfill({
            status: 404,
            json: {
              code: 'conversation_owner_missing',
              message: 'Owner missing',
            },
          })
        : route.fulfill({
            json: {
              canvasId: child,
              nodeId: node.id,
              threadId,
              spaceTitle: `Sync child ${direction}`,
              source: node.data,
            },
          });
    });
    await context.route(`**/api/agent/history/${threadId}/page?**`, (route) =>
      route.fulfill({ json: { threadId, turns, hasMore: false } }),
    );
    await context.route(`**/api/agent/stream/${threadId}?**`, (route) => {
      if (status !== 'running')
        return route.fulfill({
          status: 404,
          json: { message: 'No active run' },
        });
      if (route.request().frame().page() === observer) observerAttachments++;
      return route.fulfill({
        headers: { 'x-test-stream': 'true' },
        json: { key: streamKey, events: [partial] },
      });
    });
    await context.route('**/api/agent', async (route) => {
      sendCount++;
      submitted = route.request().postDataJSON();
      status = 'running';
      turns.push({
        id: 'current',
        active: true,
        messages: [{ role: 'user', content: 'Start in the other Space' }],
      });
      await project({ status, invocationToken: 'cross-space-run' });
      await route.fulfill({
        headers: { 'x-test-stream': 'true' },
        json: {
          key: streamKey,
          events: [
            {
              type: 'accepted',
              data: {
                threadId,
                requestId: submitted?.requestId,
                turnStartSeq: 10,
              },
            },
            partial,
          ],
        },
      });
    });
    await Promise.all([
      page.goto(`/canvas/${parent}`),
      childPage.goto(`/canvas/${child}?node=${node.id}`),
    ]);
    await page.locator(`[data-space-agent-thread="${threadId}"]`).click();
    await expect(
      page.getByText('Previous response', { exact: true }),
    ).toBeVisible();
    await expect(
      childPage.getByText('Previous response', { exact: true }),
    ).toBeVisible();
    for (const viewer of [page, childPage]) {
      expect(
        await viewer.evaluate((key) => {
          const detail = { key, count: 0 };
          window.dispatchEvent(
            new CustomEvent('test-stream-count', { detail }),
          );
          return detail.count;
        }, ownerKey),
      ).toBe(1);
    }
    await observer.locator('textarea').last().fill('Keep observer draft');
    await sender.locator('textarea').last().fill('Start in the other Space');
    await sender.locator('textarea').last().press('Enter');
    await expect(
      sender.getByText('Live cross-Space reply', { exact: true }),
    ).toBeVisible();
    await expect(
      observer.getByText('Live cross-Space reply', { exact: true }),
    ).toBeVisible({ timeout: 2_000 });
    expect(submitted).toMatchObject({
      canvasId: child,
      threadId,
      anchorNodeId: node.id,
    });
    expect(observerAttachments).toBe(1);
    const readsBeforeLabel = ownerReads;
    await project({ label: 'Updated while streaming' });
    await publish(observer, streamKey, {
      type: 'text_delta',
      data: { content: ' continues.' },
    });
    await expect(
      observer.getByText('Live cross-Space reply continues.', { exact: true }),
    ).toBeVisible();
    expect(observerAttachments).toBe(1);
    expect(ownerReads).toBe(readsBeforeLabel);
    await expect(observer.locator('textarea').last()).toHaveValue(
      'Keep observer draft',
    );

    // Completion can reach the metadata channel before the stream's last frame.
    status = 'done';
    turns[1] = {
      id: 'current',
      messages: [
        { role: 'user', content: 'Start in the other Space' },
        {
          role: 'assistant',
          parts: [{ kind: 'text', text: 'Final canonical reply' }],
        },
      ],
    };
    await project({ status });
    await expect(
      observer.getByText('Final canonical reply', { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      observer.getByText('Start in the other Space', { exact: true }),
    ).toHaveCount(1);
    await expect(
      observer.getByRole('button', { name: 'Stop', exact: true }),
    ).toHaveCount(0);
    await expect(observer.locator('textarea').last()).toHaveValue(
      'Keep observer draft',
    );
    await publish(
      sender,
      streamKey,
      { type: 'done', data: { message: 'Final canonical reply' } },
      true,
    );
    await expect(
      sender.getByRole('button', { name: 'Stop', exact: true }),
    ).toHaveCount(0);
    // Reconnection must reconcile history even without a new lifecycle token.
    turns[1].messages.push({
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Persisted detail missed while disconnected' },
      ],
    });
    await publish(
      observer,
      ownerKey,
      {
        type: 'error',
        data: { status: 503, error: { message: 'Reconnect test' } },
      },
      true,
    );
    await expect(
      observer.getByText('Persisted detail missed while disconnected', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(observer.locator('textarea').last()).toHaveValue(
      'Keep observer draft',
    );
    expect(observerAttachments).toBe(1);
    await observer.screenshot({
      path: testInfo.outputPath(`${direction}.png`),
    });
    ownerMissing = true;
    ownerRevision++;
    const deletion = {
      type: 'update',
      data: {
        fromVersion: version,
        toVersion: ++version,
        deltas: [{ type: 'DELETE_NODE', node }],
        pendingEffects: {
          mutatedNodes: [],
          deletedNodeIds: [node.id],
          contentEditedNodeIds: [],
          deferredFitFrameIds: [],
        },
      },
    };
    await Promise.all([
      publish(page, canvasKey, deletion),
      publish(childPage, canvasKey, deletion),
      publish(page, ownerKey, ownerSnapshot()),
      publish(childPage, ownerKey, ownerSnapshot()),
    ]);
    for (const viewer of [page, childPage]) {
      await expect(
        viewer.getByText('The Agent node is no longer in this Space.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        viewer.getByText('Final canonical reply', { exact: true }),
      ).toBeVisible();
      const input = viewer.locator('textarea').last();
      await input.fill('Do not send from the invalid node');
      await expect(
        viewer.getByRole('button', { name: 'Send', exact: true }),
      ).toBeDisabled();
      await input.press('Enter');
      await expect(input).toHaveValue('Do not send from the invalid node\n');
      expect(sendCount).toBe(1);
      await viewer.screenshot({
        path: testInfo.outputPath(
          `${direction}-${viewer === page ? 'parent' : 'child'}-unavailable.png`,
        ),
      });
    }
    await observer.reload();
    const restoredPreview = observer.getByRole('tabpanel');
    await expect(
      restoredPreview.getByRole('status').filter({
        hasText: 'The Agent node is no longer in this Space.',
      }),
    ).toBeVisible();
    await expect(
      restoredPreview
        .getByText('Final canonical reply', { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      restoredPreview.getByRole('button', { name: 'Send', exact: true }),
    ).toBeDisabled();
    expect(sendCount).toBe(1);
    await childPage.close();
  });
}
