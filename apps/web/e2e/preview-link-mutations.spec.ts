// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test } from '@playwright/test';

import type {
  createMilkdown as CreateMilkdown,
  MilkdownInstance,
} from '../src/components/Milkdown/createMilkdown';

for (const previewMode of [false, true]) {
  for (const initiallyLinked of [false, true]) {
    test(`${previewMode ? 'drag-only' : 'read-only'} preview settles with ${initiallyLinked ? 'linked' : 'link-free'} initial content`, async ({
      page,
    }) => {
      // Reuse the empty chat fixture and its Vite module graph, without an Agent
      // or persisted conversation. Exercise the production factory, not a copy.
      await page.goto('/playground/chat-performance?messages=0');
      const result = await page.evaluate(
        async ({ previewMode, initiallyLinked }) => {
          const modulePath = '/src/components/Milkdown/createMilkdown.ts';
          const { createMilkdown } = (await import(modulePath)) as {
            createMilkdown: typeof CreateMilkdown;
          };
          const root = document.createElement('div');
          document.body.append(root);
          const originalAdd = DOMTokenList.prototype.add;
          const originalOpen = window.open;
          let editor: MilkdownInstance | undefined;
          let writes = 0;
          let redundantWrites = 0;
          let capped = false;
          let mutations = 0;
          const opened: string[] = [];
          const observer = new MutationObserver((records) => {
            mutations += records.filter(
              (record) => record.target instanceof HTMLAnchorElement,
            ).length;
          });
          observer.observe(root, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
          });
          DOMTokenList.prototype.add = function (...tokens: string[]) {
            if (tokens.includes('nodrag')) {
              // Bound the broken implementation so a regression fails rather
              // than starving Chromium's event loop and hanging the worker.
              if (writes >= 40) {
                capped = true;
                return;
              }
              writes++;
              if (this.contains('nodrag')) redundantWrites++;
            }
            return originalAdd.apply(this, tokens);
          };
          window.open = (url) => {
            opened.push(String(url));
            return null;
          };
          const settle = async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const before = { writes, mutations };
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              before,
              after: { writes, mutations },
              links: root.querySelectorAll('a[href]').length,
              marked: root.querySelectorAll('a[href].nodrag').length,
            };
          };
          try {
            editor = await createMilkdown({
              root,
              initialMarkdown: initiallyLinked
                ? '[initial](https://example.com/initial)'
                : 'No links yet.',
              editable: previewMode,
              previewMode,
            });
            const initial = await settle();
            editor.setMarkdown(
              '[updated](https://example.org/updated) and [second](https://example.org/second)',
            );
            const updated = await settle();
            const markdown = editor.getMarkdown();
            editor.__setCursorAfterTextForTest?.('updated');
            const selected = await settle();
            root.querySelector('a')?.dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 1,
              }),
            );
            editor.setMarkdown('Links removed.');
            const removed = await settle();
            return {
              initial,
              updated,
              selected,
              removed,
              redundantWrites,
              capped,
              opened,
              markdown,
            };
          } finally {
            await editor?.destroy();
            observer.disconnect();
            DOMTokenList.prototype.add = originalAdd;
            window.open = originalOpen;
            root.remove();
          }
        },
        { previewMode, initiallyLinked },
      );

      expect(result.capped).toBe(false);
      expect(result.redundantWrites).toBe(0);
      expect(result.removed.after.writes).toBe(0);
      expect(result.markdown.trim()).toBe(
        '[updated](https://example.org/updated) and [second](https://example.org/second)',
      );
      expect(result.initial.links).toBe(initiallyLinked ? 1 : 0);
      expect(result.updated.links).toBe(2);
      expect(result.selected.after.writes).toBe(result.updated.after.writes);
      expect(result.removed.links).toBe(0);
      for (const phase of [
        result.initial,
        result.updated,
        result.selected,
        result.removed,
      ]) {
        expect(phase.marked).toBe(phase.links);
        expect(phase.after).toEqual(phase.before);
      }
      expect(result.opened).toEqual(['https://example.org/updated']);
    });
  }
}
