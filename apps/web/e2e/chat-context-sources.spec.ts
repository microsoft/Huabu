// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator } from '@playwright/test';

import type * as InputModule from '../src/components/Panels/ChatPanel/ChatInput';
import type * as SessionModule from '../src/hooks/useChatSession';
import type CanvasStore from '../src/store/canvasStore';
import type * as ChatStore from '../src/store/chatStore';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';

const excerpt =
  'The selected passage is included automatically, without an extra confirmation click.';

test.use({ hasTouch: false });

async function expectSharedChipTone(sources: Locator, textbox: Locator) {
  await textbox.page().addStyleTag({
    content:
      '[data-chat-input-surface], [data-chat-context-sources] * { transition: none !important; }',
  });
  const chips = sources.locator(
    '[data-context-attachment], button:has(.lucide-plus), [tabindex="0"]',
  );
  const tones = () =>
    chips.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      }),
    );
  await textbox.evaluate((element) => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    element.closest('[data-chat-input-surface]')?.scrollIntoView();
  });
  await expect
    .poll(
      async () =>
        new Set((await tones()).map((tone) => JSON.stringify(tone))).size,
    )
    .toBe(1);
  const [resting] = await tones();
  await textbox.focus();
  await expect
    .poll(async () => {
      const focused = await tones();
      return (
        focused.every(
          (tone) =>
            tone.background !== resting.background &&
            tone.color !== resting.color,
        ) && new Set(focused.map((tone) => JSON.stringify(tone))).size === 1
      );
    })
    .toBe(true);
  const surface = textbox.locator(
    'xpath=ancestor::*[@data-chat-input-surface]',
  );
  await expect
    .poll(async () =>
      surface.evaluate((element) => getComputedStyle(element).borderTopColor),
    )
    .toBe((await tones())[0].color);
  await textbox.evaluate((element) => element.blur());
  await expect
    .poll(tones)
    .toEqual(Array.from({ length: await chips.count() }, () => resting));
}

for (const width of [320, 520]) {
  test(`unified chat sources remain readable and actionable at ${width}px`, async ({
    page,
  }) => {
    await page.goto('/playground/chat-performance?messages=0');
    await expect(page.getByRole('textbox')).toBeVisible();
    await page.evaluate(
      async ({ width, excerpt }) => {
        const loadedStore = (name: string) => {
          const entry = performance
            .getEntriesByType('resource')
            .find(
              (resource) =>
                new URL(resource.name).pathname === `/src/store/${name}.ts`,
            );
          if (!entry) throw new Error(`Missing loaded store: ${name}`);
          return entry.name;
        };
        const [{ default: canvas }, { useChatStore: chat }] = await Promise.all(
          [
            import(loadedStore('canvasStore')) as Promise<{
              default: typeof CanvasStore;
            }>,
            import(loadedStore('chatStore')) as Promise<typeof ChatStore>,
          ],
        );
        canvas.getState()._setStateNoAutosave({
          canvasId: 'chat-performance-canvas',
          nodes: ['Research notes', 'Product outline', 'User feedback'].map(
            (label, index) => ({
              id: `source-${index}`,
              type: 'note',
              selected: true,
              position: { x: 0, y: 0 },
              data: { label },
            }),
          ),
          edges: [],
        });
        chat.getState().setSelectionAttachment({
          type: 'text',
          source: 'excerpt',
          originNodeId: 'source-0',
          content: excerpt,
        });
        chat.getState().addPendingAttachment('chat-performance-thread', {
          type: 'file',
          source: 'upload',
          filename: 'research-notes.md',
          content:
            'File body should be in the attachment, not replace its name.',
        });
        const fixture = document.querySelector<HTMLElement>(
          '[data-chat-performance-fixture]',
        );
        if (!fixture) throw new Error('Missing chat fixture');
        fixture.style.width = `${width}px`;
      },
      { width, excerpt },
    );

    const sources = page.locator('[data-chat-context-sources]');
    const included = sources.getByRole('group', {
      name: 'Included with your message',
    });
    await expect(included.getByText(excerpt, { exact: true })).toBeVisible();
    await expect(
      included.getByText('research-notes.md', { exact: true }),
    ).toBeVisible();
    await expect(
      sources.getByText('3 selected nodes', { exact: true }),
    ).toBeVisible();
    const inputSurface = page.locator('[data-chat-input-surface]');
    const layout = await inputSurface.evaluate((surface) => {
      const bounds = surface.getBoundingClientRect();
      const row = surface.querySelector<HTMLElement>(
        '[data-chat-context-sources]',
      );
      if (!row) throw new Error('Missing context row');
      const rowBounds = row.getBoundingClientRect();
      const chips = [
        ...row.querySelectorAll<HTMLElement>(
          '[data-context-attachment], [tabindex="0"]',
        ),
      ];
      const rows = new Set(
        chips.map((element) => element.getBoundingClientRect().top),
      );
      return {
        fits: rowBounds.left >= bounds.left && rowBounds.right <= bounds.right,
        rowHeight: rowBounds.height,
        rows: rows.size,
        widths: chips.map((element) => element.getBoundingClientRect().width),
        scrollWidth: surface.scrollWidth,
        clientWidth: surface.clientWidth,
      };
    });
    expect(layout.fits).toBe(true);
    expect(layout.rows).toBe(width === 320 ? 2 : 1);
    expect(layout.rowHeight).toBe(layout.rows * 24 + (layout.rows - 1) * 4);
    for (const chipWidth of layout.widths)
      expect(chipWidth).toBeLessThanOrEqual(160);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    await page.mouse.move(0, 0);
    await expectSharedChipTone(sources, page.getByRole('textbox'));

    const excerptChip = included
      .locator('[data-context-attachment]')
      .filter({ hasText: excerpt });
    expect((await excerptChip.boundingBox())?.height).toBe(24);
    await expect(
      sources.locator('svg:not(.lucide-x):not(.lucide-pin)'),
    ).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(
      excerptChip.getByRole('button', { name: 'Remove attachment' }),
    ).toHaveCount(0);
    const pin = included.getByRole('button', {
      name: 'Pin this excerpt to this chat',
    });
    await expect(pin).toHaveText(excerpt);
    await expect(pin.locator('svg.lucide-pin')).toHaveCount(1);
    await pin.focus();
    await pin.press('Enter');
    await expect(pin).toHaveCount(0);
    await expect(included.getByText(excerpt, { exact: true })).toBeVisible();
    await expect(excerptChip.getByRole('button')).toHaveCount(1);
    const remove = excerptChip.getByRole('button', {
      name: 'Remove attachment',
    });
    await expect(remove).toBeVisible();
    const removeBounds = await remove.boundingBox();
    const textBounds = await excerptChip
      .getByText(excerpt, { exact: true })
      .boundingBox();
    expect(removeBounds?.x).toBeLessThan(textBounds?.x ?? 0);

    const pinned = await page.evaluate(async () => {
      const entry = performance
        .getEntriesByType('resource')
        .find(
          (resource) =>
            new URL(resource.name).pathname === '/src/store/chatStore.ts',
        );
      if (!entry) throw new Error('Missing chat store');
      const { useChatStore, selectThreadPendingAttachments } = (await import(
        entry.name
      )) as typeof ChatStore;
      const state = useChatStore.getState();
      return {
        selection: state.selectionAttachment,
        pending: selectThreadPendingAttachments(
          state,
          'chat-performance-thread',
        ),
        other: selectThreadPendingAttachments(state, 'other-thread'),
      };
    });
    expect(pinned.selection).toBeNull();
    expect(pinned.pending).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: excerpt })]),
    );
    expect(pinned.other).toEqual([]);

    await included
      .locator('[data-context-attachment]')
      .filter({ hasText: excerpt })
      .getByRole('button', { name: 'Remove attachment' })
      .click();
    await expect(included.getByText(excerpt, { exact: true })).toHaveCount(0);
    await expect(
      included.getByText('research-notes.md', { exact: true }),
    ).toBeVisible();
    await expect(
      sources.getByText('3 selected nodes', { exact: true }),
    ).toBeVisible();
  });
}

test('adjacent source shares chip styling and keeps the Canvas summary last', async ({
  page,
}) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(2000));
  await page.goto('/playground/chat-performance?messages=0');
  await expect(page.getByRole('textbox')).toBeVisible();
  const label =
    'Jupybara: Operationalizing a Design Space for Actionable Data Science Workflows';
  await page.evaluate(async (label) => {
    const loaded = (suffix: string) => {
      const entry = performance
        .getEntriesByType('resource')
        .find((resource) => new URL(resource.name).pathname.endsWith(suffix));
      if (!entry) throw new Error(`Missing loaded module: ${suffix}`);
      return entry.name;
    };
    const [
      { default: React },
      { default: ReactDOM },
      { ChatInput },
      { ChatSessionProvider },
      { default: canvas },
    ] = await Promise.all([
      import(loaded('/deps/react.js')) as Promise<{
        default: typeof ReactModule;
      }>,
      import(loaded('/deps/react-dom_client.js')) as Promise<{
        default: typeof ReactDOMModule;
      }>,
      import(loaded('/ChatInput.tsx')) as Promise<typeof InputModule>,
      import(loaded('/useChatSession.ts')) as Promise<typeof SessionModule>,
      import(loaded('/src/store/canvasStore.ts')) as Promise<{
        default: typeof CanvasStore;
      }>,
    ]);
    canvas.getState()._setStateNoAutosave({
      canvasId: 'candidate-canvas',
      nodes: [
        {
          id: 'candidate',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label },
        },
        {
          id: 'selected',
          type: 'note',
          selected: true,
          position: { x: 0, y: 0 },
          data: { label: 'Selected note' },
        },
      ],
      edges: [],
    });
    const existing = document.querySelector<HTMLElement>(
      '[data-chat-performance-fixture]',
    );
    if (!existing) throw new Error('Missing chat fixture');
    existing.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'candidate-fixture';
    host.style.width = '320px';
    host.style.position = 'fixed';
    host.style.top = '24px';
    host.style.left = '24px';
    document.body.append(host);
    ReactDOM.createRoot(host).render(
      React.createElement(
        ChatSessionProvider,
        {
          value: {
            canvasId: 'candidate-canvas',
            ownerCanvasId: 'candidate-canvas',
            threadId: 'candidate-thread',
            conversationView: null,
          },
        },
        React.createElement(ChatInput, {
          value: '',
          onChange: () => undefined,
          onSubmit: () => undefined,
          onStop: () => undefined,
          mode: 'operate',
          adjacentNodeSourceId: 'candidate',
        }),
      ),
    );
  }, label);
  const host = page.locator('#candidate-fixture');
  const candidate = host.getByRole('button', {
    name: `Add ${label}`,
    exact: true,
  });
  await expect(candidate).toHaveText(label);
  await expect(candidate.locator('svg.lucide-plus')).toHaveCount(1);
  await expect(candidate).toBeInViewport();
  await page.mouse.move(1000, 700);
  for (const width of [320, 520]) {
    await host.evaluate((element, width) => {
      element.style.width = `${width}px`;
    }, width);
    const layout = await candidate.evaluate((element) => {
      const surface = element.closest('[data-chat-input-surface]');
      const textarea = surface?.querySelector('textarea');
      const row = surface?.querySelector('[data-chat-context-sources]');
      if (!surface || !textarea || !row) throw new Error('Missing composer');
      const rect = element.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      const rowBounds = row.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rowBounds.left - bounds.left,
        right: bounds.right - rowBounds.right,
        textLeft: textarea.getBoundingClientRect().left,
        chipLeft: rect.left,
        border: style.borderLeftStyle,
        borderWidth: parseFloat(style.borderLeftWidth),
        height: rect.height,
        width: rect.width,
      };
    });
    expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(1);
    expect(layout.chipLeft).toBe(layout.textLeft);
    expect(layout.border).toBe('none');
    expect(layout.borderWidth).toBe(0);
    expect(layout.height).toBe(24);
    expect(layout.width).toBeLessThanOrEqual(160);
    const summaryBounds = await host
      .locator('[data-chat-context-sources] [tabindex="0"]')
      .boundingBox();
    const candidateBounds = await candidate.boundingBox();
    expect(summaryBounds?.y).toBe(candidateBounds?.y);
    expect(summaryBounds?.x).toBeGreaterThan(candidateBounds?.x ?? 0);
  }
  await expectSharedChipTone(
    host.locator('[data-chat-context-sources]'),
    host.getByRole('textbox'),
  );
  await candidate.press('Enter');
  await expect(candidate).toHaveCount(0);
  await expect(
    host.getByRole('group', { name: 'Included with your message' }),
  ).toContainText(label);
  await expect(host.locator('svg.lucide-plus')).toHaveCount(0);
  await expect(
    host.getByRole('button', { name: 'Remove attachment' }),
  ).toBeVisible();
  await expect(host.locator('[data-chat-context-sources]')).toHaveText(
    `${label}1 selected node`,
  );
});
