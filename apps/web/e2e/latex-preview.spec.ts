// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Page } from '@playwright/test';

import type * as MessageModule from '../src/components/Messages/AIMessage';
import type * as SessionModule from '../src/hooks/useChatSession';
import type * as ToolModule from '../src/store/toolStore';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';

declare global {
  interface Window {
    latexFixture: { render(content: string, streaming: boolean): void };
  }
}

const prose = String.raw`\keypoint{Automated trace-driven optimization uses traces to propose
changes but relies on task-level evaluation to establish their value.}
However, execution traces alone do not establish whether a proposed
change improves efficiency without compromising task performance.`;

async function mount(page: Page, theme: string, input: 'mouse' | 'finger') {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(2000));
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) =>
      route.fulfill({
        status: 503,
        body: 'Isolated renderer fixture: no backend',
      }),
  );
  await page.goto('/playground/chat-performance?messages=2');
  await expect(page.locator('textarea[name="agent-message"]')).toBeVisible();
  await page.evaluate(
    async ({ theme, input }) => {
      const loaded = (suffix: string) => {
        const resource = performance
          .getEntriesByType('resource')
          .find((entry) => new URL(entry.name).pathname.endsWith(suffix));
        if (!resource) throw new Error(`Missing loaded module: ${suffix}`);
        return resource.name;
      };
      const [
        { default: React },
        { default: ReactDOM },
        { AIMessage },
        { ChatSessionProvider },
        { useToolStore },
      ] = await Promise.all([
        import(loaded('/deps/react.js')) as Promise<{
          default: typeof ReactModule;
        }>,
        import(loaded('/deps/react-dom_client.js')) as Promise<{
          default: typeof ReactDOMModule;
        }>,
        import(loaded('/Messages/AIMessage/index.tsx')) as Promise<
          typeof MessageModule
        >,
        import(loaded('/useChatSession.ts')) as Promise<typeof SessionModule>,
        import(loaded('/store/toolStore.ts')) as Promise<typeof ToolModule>,
      ]);
      const original = document.querySelector<HTMLElement>(
        '[data-chat-performance-fixture]',
      );
      if (!original) throw new Error('Missing original fixture');
      original.style.display = 'none';
      document.documentElement.classList.toggle('dark', theme === 'dark');
      useToolStore.setState({ inputModePreference: input });
      const host = document.createElement('main');
      host.id = 'latex-fixture';
      host.className = 'bg-surface text-fg-default';
      Object.assign(host.style, {
        position: 'fixed',
        top: '16px',
        left: '16px',
        width: '640px',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      });
      document.body.append(host);
      const root = ReactDOM.createRoot(host);
      window.latexFixture = {
        render(content, streaming) {
          root.render(
            React.createElement(
              ChatSessionProvider,
              {
                value: {
                  threadId: 'latex-test',
                  canvasId: 'latex-canvas',
                  ownerCanvasId: 'latex-canvas',
                  conversationView: null,
                },
              },
              React.createElement(AIMessage, {
                messageId: 'latex-answer',
                segments: [{ kind: 'text', text: content }],
                isStreaming: streaming,
              }),
            ),
          );
        },
      };
      window.latexFixture.render('Before source.', true);
    },
    { theme, input },
  );
}

for (const theme of ['light', 'dark']) {
  for (const input of ['mouse', 'finger'] as const) {
    test.describe(`${theme} ${input}`, () => {
      test.use({ hasTouch: input === 'finger' });
      test('source fences stay source across streaming and completion', async ({
        page,
      }, info) => {
        await mount(page, theme, input);
        const host = page.locator('#latex-fixture');
        for (const body of ['', '\\frac{a}{', '\\frac{a}{b}', prose]) {
          await page.evaluate(
            (content) => window.latexFixture.render(content, true),
            `Before source.\n\n\`\`\`latex\n${body}`,
          );
          const block = host.locator('.milkdown-code-block').first();
          await expect(block.locator('.cm-content')).toBeVisible();
          await expect(block.locator('.cm-line')).toHaveText(body.split('\n'));
          await expect(host.locator('.ProseMirror')).toHaveAttribute(
            'contenteditable',
            input === 'finger' ? 'false' : 'true',
          );
          await expect(block.locator('.preview-panel')).toHaveCount(0);
          await expect(host.locator('.katex')).toHaveCount(0);
        }
        const completed = `Before source.\n\n\`\`\`latex\n${prose}\n\`\`\`\n\nAfter source.\n\nInline $x$.\n\n$$\n\\frac{a}{b}\n$$\n\nEnd.`;
        await page.evaluate(
          (content) => window.latexFixture.render(content, false),
          completed,
        );
        const block = host.locator('.milkdown-code-block').first();
        await expect(block.locator('.preview-panel')).toHaveCount(0);
        await expect(block.locator('.cm-line')).toHaveText(prose.split('\n'));
        await expect(host.locator('.katex')).toHaveCount(2);
        await expect(
          host.getByText('After source.', { exact: true }),
        ).toBeVisible();
        await block.hover();
        await block.locator('.copy-button').click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(prose);
        await host
          .getByRole('button', { name: 'Copy message', exact: true })
          .click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(completed);
        const sourceBounds = await block.boundingBox();
        const afterBounds = await host
          .getByText('After source.', { exact: true })
          .boundingBox();
        if (!sourceBounds || !afterBounds)
          throw new Error('Missing source/paragraph bounds');
        expect(afterBounds.y).toBeGreaterThanOrEqual(
          sourceBounds.y + sourceBounds.height,
        );
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
          .poll(() =>
            host.evaluate(
              (element) => element.scrollWidth - element.clientWidth,
            ),
          )
          .toBeLessThanOrEqual(1);
        await host.screenshot({
          path: info.outputPath(`${theme}-${input}.png`),
        });
      });
    });
  }
}

test('ordinary code stays literal and invalid explicit math can recover', async ({
  page,
}) => {
  await mount(page, 'light', 'mouse');
  const host = page.locator('#latex-fixture');
  for (const language of ['latex', 'tex', 'text', '']) {
    const body = String.raw`\frac{a}{b}
$x$ and $$y$$ and \(z\) and \[w\]
<img src=x onerror="window.unexpectedImage = true">`;
    await page.evaluate(
      (content) => window.latexFixture.render(content, false),
      `\`\`\`${language}\n${body}\n\`\`\``,
    );
    await expect(host.locator('.cm-line')).toHaveText(body.split('\n'));
    await expect(host.locator('.katex, img, .preview-panel')).toHaveCount(0);
  }
  await page.evaluate(() =>
    window.latexFixture.render('$$\n\\frac{a}{\n$$', true),
  );
  await expect(host.locator('.katex-error')).toHaveCount(1);
  await page.evaluate(() =>
    window.latexFixture.render('Inline \\(x\\).\n\n\\[\\frac{a}{b}\\]', false),
  );
  await expect(host.locator('.katex-error')).toHaveCount(0);
  await expect(host.locator('.katex')).toHaveCount(2);
});
