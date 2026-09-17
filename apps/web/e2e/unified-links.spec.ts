// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, test, type Locator, type Page } from '@playwright/test';

import { openNewCanvas } from './helpers';

import type { MilkdownInstance } from '../src/components/Milkdown/createMilkdown';
import type * as EditorModule from '../src/components/Milkdown/MilkdownEditor';
import type * as ToolbarModule from '../src/components/Milkdown/MilkdownFloatingToolbar';
import type * as PreviewModule from '../src/components/Milkdown/MilkdownPreview';
import type * as NavigationModule from '../src/utils/openDocumentLink';
import type * as ReactModule from 'react';
import type * as ReactDOMModule from 'react-dom/client';

type Surface = 'note' | 'chat' | 'preview';

declare global {
  interface Window {
    __unifiedLinks?: {
      changes: string[];
      instance: MilkdownInstance | null;
      unmount: () => void;
    };
  }
}

const href = 'https://example.com/unified-links';
const markdown = `Before [original linked words](${href}) after the link.`;

test.use({ hasTouch: false });

/** Mount production React wrappers using the already-running Vite module graph. */
async function mountSurfaces(
  page: Page,
  initial = markdown,
  genericEditor = false,
): Promise<void> {
  await page.goto('/playground/chat-performance?messages=0');
  await page.evaluate(
    async ({ initialMarkdown, genericEditor }) => {
      const dependencyUrl = (file: string) => {
        const resource = performance
          .getEntriesByType('resource')
          .find((entry) =>
            new URL(entry.name).pathname.endsWith(`/deps/${file}.js`),
          );
        if (!resource) throw new Error(`Vite has not loaded ${file}`);
        return resource.name;
      };
      // Reuse Vite's versioned URLs; unversioned imports instantiate a second renderer.
      const reactPath = dependencyUrl('react');
      const domPath = dependencyUrl('react-dom_client');
      const editorPath = '/src/components/Milkdown/MilkdownEditor.tsx';
      const toolbarPath =
        '/src/components/Milkdown/MilkdownFloatingToolbar.tsx';
      const previewPath = '/src/components/Milkdown/MilkdownPreview.tsx';
      const navigationPath = '/src/utils/openDocumentLink.ts';
      const [
        { default: React },
        { default: ReactDOM },
        { MilkdownEditor },
        { MilkdownPreview },
        host,
        { MilkdownFloatingToolbar },
      ] = await Promise.all([
        import(reactPath) as Promise<{ default: typeof ReactModule }>,
        import(domPath) as Promise<{
          default: typeof ReactDOMModule;
        }>,
        import(editorPath) as Promise<typeof EditorModule>,
        import(previewPath) as Promise<typeof PreviewModule>,
        import(navigationPath) as Promise<typeof NavigationModule>,
        import(toolbarPath) as Promise<typeof ToolbarModule>,
      ]);
      const container = document.createElement('div');
      container.dataset.testid = 'unified-links';
      // Only fixture placement is styled here; link/editor CSS remains production CSS.
      container.className = 'bg-surface';
      Object.assign(container.style, {
        position: 'fixed',
        inset: '20px',
        zIndex: '100',
        overflow: 'auto',
        padding: '24px',
      });
      document.body.append(container);
      const root = ReactDOM.createRoot(container);
      const state: NonNullable<Window['__unifiedLinks']> = {
        changes: [],
        instance: null,
        unmount: () => {
          root.unmount();
          container.remove();
        },
      };
      window.__unifiedLinks = state;
      function Surfaces() {
        const [value, setValue] = React.useState(initialMarkdown);
        const [editor, setEditor] = React.useState<MilkdownInstance | null>(
          null,
        );
        const surfaceRef = React.useRef<HTMLElement | null>(null);
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'section',
            { 'data-testid': 'note', ref: surfaceRef },
            React.createElement('h2', null, 'Expanded Note'),
            React.createElement(MilkdownFloatingToolbar, {
              instance: editor,
              surfaceRef,
            }),
            React.createElement(MilkdownEditor, {
              markdown: value,
              linkActivation: genericEditor ? 'modifier' : 'plain',
              onLinkClick: genericEditor
                ? undefined
                : (url: string) =>
                    host.openDocumentLink(url, { nodeId: 'acceptance-note' }),
              onChange: (next: string) => {
                state.changes.push(next);
                setValue(next);
              },
              onReady: (instance: MilkdownInstance | null) => {
                state.instance = instance;
                setEditor(instance);
              },
            }),
          ),
          ...(['chat', 'preview'] as const).map((surface) =>
            React.createElement(
              'section',
              { key: surface, 'data-testid': surface },
              React.createElement('h2', null, surface),
              React.createElement(MilkdownPreview, {
                markdown: initialMarkdown,
                enableBlockDrag: surface === 'chat',
                linkActivation: 'plain',
                onLinkClick: (url: string) =>
                  host.openDocumentLink(url, { threadId: 'acceptance-chat' }),
              }),
            ),
          ),
        );
      }
      root.render(React.createElement(Surfaces));
    },
    { initialMarkdown: initial, genericEditor },
  );
  for (const surface of ['note', 'chat', 'preview'] as const) {
    await expect(
      page.getByTestId(surface).locator('.ProseMirror'),
    ).toBeVisible();
  }
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__unifiedLinks?.instance)))
    .toBe(true);
}

function link(page: Page, surface: Surface): Locator {
  return page.getByTestId(surface).locator('.ProseMirror a');
}

async function changes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    if (!window.__unifiedLinks) throw new Error('React fixture not mounted');
    return window.__unifiedLinks.changes;
  });
}

/** Observe real popups, fulfilling only the external test destination locally. */
async function observeNavigation(page: Page): Promise<Page[]> {
  await page.context().route('https://example.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Link destination</title>',
    }),
  );
  const opened: Page[] = [];
  page.on('popup', (popup) => opened.push(popup));
  return opened;
}

async function expectNavigations(opened: Page[], count: number): Promise<void> {
  await expect.poll(() => opened.length).toBe(count);
  for (const popup of opened) await expect(popup).toHaveURL(href);
}

async function settleBrowser(page: Page): Promise<void> {
  // Bound the observation window for absence assertions and deferred editor listeners.
  await page.waitForTimeout(350);
}

async function hoverForm(page: Page): Promise<Locator> {
  await link(page, 'note').hover();
  const form = page.getByRole('dialog', { name: 'Edit link', exact: true });
  await expect(form).toBeVisible();
  return form;
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('link-browser-state', {
      body: JSON.stringify(
        await page.evaluate(() => ({
          changes: window.__unifiedLinks?.changes,
          markdown: window.__unifiedLinks?.instance?.getMarkdown(),
          focus: document.activeElement?.outerHTML,
          selection: window.getSelection()?.toString(),
          dialog: document.querySelector('[role="dialog"]')?.outerHTML,
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
  await page.evaluate(() => window.__unifiedLinks?.unmount());
});

for (const submit of ['button', 'Enter'] as const) {
  test(`Note hover preserves focus and atomically saves display text and URL via ${submit}`, async ({
    page,
  }) => {
    await mountSurfaces(page);
    const editor = page.getByTestId('note').locator('.ProseMirror');
    await editor.focus();
    const form = await hoverForm(page);
    await expect(editor).toBeFocused();
    await expect(form.getByLabel('Display text')).toHaveValue(
      'original linked words',
    );
    await expect(form.getByLabel('Link URL')).toHaveValue(href);
    await form.getByLabel('Display text').fill('renamed link');
    await form.getByLabel('Link URL').fill('https://example.com/changed');
    expect(await changes(page)).toEqual([]);
    if (submit === 'Enter') await form.getByLabel('Link URL').press('Enter');
    else await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(link(page, 'note')).toHaveText('renamed link');
    await expect(link(page, 'note')).toHaveAttribute(
      'href',
      'https://example.com/changed',
    );
    await settleBrowser(page);
    await expect(form).toBeHidden();
    expect(await changes(page)).toEqual([
      'Before [renamed link](https://example.com/changed) after the link.',
    ]);
    // A single native undo must restore both fields, not an intermediate edit.
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(link(page, 'note')).toHaveText('original linked words');
    await expect(link(page, 'note')).toHaveAttribute('href', href);
  });
}

for (const entry of ['toolbar', 'shortcut'] as const) {
  test(`generic editable editor ${entry} creates a mixed-mark link in the canonical panel`, async ({
    page,
  }) => {
    await mountSurfaces(page, 'ordinary **bold** text', true);
    const editor = page.getByTestId('note').locator('.ProseMirror');
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+a');
    const selected = await page.evaluate(() =>
      window.__unifiedLinks?.instance?.getSelectionRange(),
    );
    const trigger = page.getByRole('button', { name: 'Link', exact: true });
    await expect(trigger).toBeVisible();
    if (entry === 'toolbar') await trigger.click();
    else await page.keyboard.press('ControlOrMeta+k');
    const form = page.getByRole('dialog', { name: 'Create link', exact: true });
    await expect(form).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByPlaceholder('https://example.com')).toHaveCount(0);
    await expect(form.getByLabel('Display text')).toBeFocused();
    await expect(form.getByLabel('Display text')).toHaveValue(
      'ordinary bold text',
    );
    await expect(
      form.getByRole('button', { name: 'Remove link' }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(editor).toBeFocused();
    expect(
      await page.evaluate(() =>
        window.__unifiedLinks?.instance?.getSelectionRange(),
      ),
    ).toEqual(selected);
    // Portalled toolbar focus must still address this editor's owner.
    await trigger.focus();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(form).toBeVisible();
    await form.getByLabel('Link URL').fill('https://example.com/created');
    await form.getByLabel('Link URL').press('Enter');
    await expect(form).toBeHidden();
    await settleBrowser(page);
    await expect(form).toBeHidden();
    await expect(editor.locator('strong')).toHaveText('bold');
    await expect(editor.locator('a')).toHaveCount(3);
    expect(await changes(page)).toHaveLength(1);
    await trigger.click();
    const edit = page.getByRole('dialog', { name: 'Edit link', exact: true });
    await expect(edit).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(edit.getByLabel('Display text')).toHaveValue(
      'ordinary bold text',
    );
    await expect(edit.getByLabel('Link URL')).toHaveValue(
      'https://example.com/created',
    );
    await edit.getByLabel('Link URL').fill('https://example.com/edited');
    await edit.getByLabel('Link URL').press('Enter');
    await expect(edit).toBeHidden();
    await expect(editor.locator('a').first()).toHaveAttribute(
      'href',
      'https://example.com/edited',
    );
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('a').first()).toHaveAttribute(
      'href',
      'https://example.com/created',
    );
  });
}

test('toolbar selection overrides hover and an open selection panel rejects hover retargeting', async ({
  page,
}) => {
  await mountSurfaces(page);
  await hoverForm(page);
  await page.evaluate(() =>
    window.__unifiedLinks?.instance?.__selectTextBetweenForTest?.(
      'Before',
      'Before',
    ),
  );
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create link', exact: true });
  await expect(form.getByLabel('Display text')).toHaveValue('Before');
  await link(page, 'note').hover();
  await expect(form.getByLabel('Display text')).toHaveValue('Before');
  await form.getByLabel('Link URL').fill('https://example.com/selected');
  await form.getByLabel('Link URL').press('Enter');
  await expect(form).toBeHidden();
  await expect(link(page, 'note').first()).toHaveText('Before');
  await expect(link(page, 'note').last()).toHaveAttribute('href', href);
});

test('selected blocks retain structure and a stale panel closes on document replacement', async ({
  page,
}) => {
  await mountSurfaces(page, 'first **bold**\n\n- second\n- third');
  const editor = page.getByTestId('note').locator('.ProseMirror');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+k');
  const form = page.getByRole('dialog', { name: 'Create link', exact: true });
  await expect(form.getByLabel('Display text')).toHaveAttribute('readonly', '');
  await expect(form.getByLabel('Display text')).toBeFocused();
  await form.getByLabel('Link URL').fill('https://example.com/blocks');
  await expect(form.getByLabel('Link URL')).toHaveValue(
    'https://example.com/blocks',
  );
  await form.getByLabel('Link URL').press('Enter');
  await expect(form).toBeHidden();
  await expect(editor.locator('li')).toHaveCount(2);
  await expect(editor.locator('strong')).toHaveText('bold');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('a')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(form).toBeVisible();
  await page.evaluate(() =>
    window.__unifiedLinks?.instance?.setMarkdown('replacement document'),
  );
  await expect(form).toBeHidden();
  await expect(editor).toHaveText('replacement document');
  await expect(editor.locator('a')).toHaveCount(0);
});

test('Note copies the captured address using origin-scoped clipboard permission', async ({
  page,
  context,
}) => {
  await mountSurfaces(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.bringToFront();
  await page.evaluate(() =>
    navigator.clipboard.writeText('clipboard sentinel'),
  );
  const form = await hoverForm(page);
  await form.getByLabel('Link URL').fill('https://example.com/unsaved');
  await form.getByRole('button', { name: 'Copy address' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(href);
  await expect(
    form.getByRole('button', { name: 'Copied', exact: true }),
  ).toBeVisible();
  expect(await changes(page)).toEqual([]);
});

test('Note remove retains original text rather than unsaved form text', async ({
  page,
}) => {
  await mountSurfaces(page);
  const form = await hoverForm(page);
  await form.getByLabel('Display text').fill('unsaved replacement');
  await form.getByRole('button', { name: 'Remove link' }).click();
  await expect(form).toBeHidden();
  await expect(link(page, 'note')).toHaveCount(0);
  await expect(page.getByTestId('note').locator('.ProseMirror')).toHaveText(
    'Before original linked words after the link.',
  );
  await expect
    .poll(() => changes(page))
    .toEqual(['Before original linked words after the link.']);
});

for (const modifier of ['Meta', 'Control']) {
  test(`Note ${modifier}+K focuses link editing and Escape restores the editor`, async ({
    page,
  }) => {
    await mountSurfaces(page);
    const editor = page.getByTestId('note').locator('.ProseMirror');
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press(`${modifier}+k`);
    const form = page.getByRole('dialog', { name: 'Edit link', exact: true });
    await expect(form).toBeVisible();
    await expect.soft(form.getByLabel('Display text')).toBeFocused();
    await expect(form.getByLabel('Link URL')).toHaveValue(href);
    await form.getByLabel('Display text').fill('discard me');
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(editor).toBeFocused();
    expect(await changes(page)).toEqual([]);
  });
}

for (const submit of ['button', 'Enter'] as const) {
  test(`Note invalid URL remains in the form without changing the document via ${submit}`, async ({
    page,
  }) => {
    await mountSurfaces(page);
    const form = await hoverForm(page);
    for (const invalid of [
      'javascript:alert(1)',
      'mailto:person@example.com',
      'not a URL',
    ]) {
      await form.getByLabel('Link URL').fill(invalid);
      if (submit === 'Enter') await form.getByLabel('Link URL').press('Enter');
      else
        await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(form).toBeVisible();
      await expect(form.getByRole('alert')).toHaveText(
        'Enter a valid HTTP or HTTPS URL.',
      );
      await expect(form.getByLabel('Link URL')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await expect(link(page, 'note')).toHaveAttribute('href', href);
      expect(await changes(page)).toEqual([]);
    }
  });
}

test('Chat and expanded Note share the native pointer cursor without Chat edit chrome', async ({
  page,
}) => {
  await mountSurfaces(page);
  for (const surface of ['note', 'chat', 'preview'] as const) {
    await expect(link(page, surface)).toHaveCSS('cursor', 'pointer');
  }
  await link(page, 'chat').hover();
  await settleBrowser(page);
  await expect(
    page.getByRole('dialog', { name: 'Edit link', exact: true }),
  ).toHaveCount(0);
});

for (const surface of ['note', 'chat', 'preview'] as const) {
  for (const gesture of ['single', 'double'] as const) {
    test(`${surface} native ${gesture} click opens exactly one browser tab`, async ({
      page,
    }) => {
      const opened = await observeNavigation(page);
      await mountSurfaces(page);
      if (gesture === 'double') await link(page, surface).dblclick();
      else await link(page, surface).click();
      await expectNavigations(opened, 1);
      await settleBrowser(page);
      expect(opened).toHaveLength(1);
      expect(await changes(page)).toEqual([]);
    });
  }

  test(`${surface} native text selection does not navigate; a fresh click still does`, async ({
    page,
  }) => {
    const opened = await observeNavigation(page);
    await mountSurfaces(page);
    const anchor = link(page, surface);
    await anchor.scrollIntoViewIfNeeded();
    const box = await anchor.boundingBox();
    if (!box) throw new Error('Link has no browser layout');
    // Start in the preceding plain text, then cross the link using native selection.
    await page.mouse.move(box.x - 15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toMatch(/linked/);
    await settleBrowser(page);
    expect(opened).toHaveLength(0);
    expect(await changes(page)).toEqual([]);
    await anchor.click();
    await expectNavigations(opened, 1);
  });
}

async function createCanvasNote(
  page: Page,
  content = `${markdown}\n\nA canvas acceptance note.`,
): Promise<Locator> {
  await openNewCanvas(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  const canvasId = page.url().split('/canvas/')[1]?.split(/[?#]/)[0];
  if (!canvasId) throw new Error('Canvas ID missing');
  // Reuse note-auto-height's headless creation pattern: real backend, sync, and NoteNode.
  const response = await page.request.post(`/api/canvas/${canvasId}/execute`, {
    data: {
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              data: {
                label: 'Link acceptance',
                content,
              },
              position: { x: 100, y: 100 },
              size: { width: 560, height: 'auto' },
            },
          ],
        },
      ],
      originator: { source: 'agent', threadId: 'e2e-unified-links' },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const note = page.locator('.react-flow__node-note');
  await expect(note).toHaveCount(1);
  await expect(note.locator('.ProseMirror')).toBeVisible();
  return note;
}

for (const selection of ['link', 'ordinary', 'caret', 'mixed'] as const) {
  test(`real NotePreview toolbar Link with ${selection} selection`, async ({
    page,
  }) => {
    const note = await createCanvasNote(page);
    await note.dblclick({ timeout: 10_000 });
    const editor = page.locator('.milkdown-note-preview .ProseMirror');
    await expect(editor).toBeVisible();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    const start = selection === 'link' ? 'Before '.length : 0;
    const text =
      selection === 'link'
        ? 'original linked words'
        : selection === 'ordinary'
          ? 'Before'
          : selection === 'mixed'
            ? 'Before original linked words'
            : '';
    for (let i = 0; i < start; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < text.length; i++)
      await page.keyboard.press('Shift+ArrowRight');
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe(text);
    const trigger = page.getByRole('button', { name: 'Link', exact: true });
    if (selection === 'caret') {
      await expect(trigger).toBeHidden();
      await page.keyboard.press('ControlOrMeta+k');
      await settleBrowser(page);
      await expect(
        page.getByRole('dialog', { name: /^(Create|Edit) link$/ }),
      ).toHaveCount(0);
      return;
    }
    await expect(trigger).toBeVisible();
    const form = page.getByRole('dialog', {
      name: selection === 'link' ? 'Edit link' : 'Create link',
      exact: true,
    });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Display text')).toBeFocused();
    await expect(form.getByLabel('Display text')).toHaveValue(text);
    await expect(form.getByLabel('Link URL')).toHaveValue(
      selection === 'link' ? href : '',
    );
    await form.getByLabel('Link URL').fill('https://example.com/toolbar');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(
      editor.locator('a[href="https://example.com/toolbar"]'),
    ).toHaveText(text);
  });
}

for (const scenario of [
  {
    name: 'ordinary text through a partial bold link',
    start: 'plain',
    end: 'bold',
  },
  { name: 'partial links with different URLs', start: 'bold', end: 'second' },
  {
    name: 'cross-block mixed links',
    start: 'bold',
    end: 'third',
    crossBlock: true,
  },
]) {
  test(`real NotePreview toolbar relinks ${scenario.name} and undoes atomically`, async ({
    page,
  }) => {
    const note = await createCanvasNote(
      page,
      'plain [left **bold** end](https://first.example "First") gap [second right](https://second.example "Second") [outside](https://outside.example "Outside")\n\n- [third last](https://third.example "Third")\n- untouched',
    );
    await note.dblclick();
    const editor = page.locator('.milkdown-note-preview .ProseMirror');
    await expect(editor).toBeVisible();
    // Read the actual Note document, including every character's link and bold marks.
    const readDocument = () =>
      editor.evaluate((element) => {
        const chars: {
          text: string;
          href: string | null;
          title: string | null;
          bold: boolean;
        }[] = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.parentElement?.closest('p')) continue;
          const anchor = node.parentElement?.closest('a');
          for (const text of node.textContent ?? '')
            chars.push({
              text,
              href: anchor?.getAttribute('href') ?? null,
              title: anchor?.getAttribute('title') ?? null,
              bold: Boolean(node.parentElement?.closest('strong')),
            });
        }
        return {
          chars,
          blocks: Array.from(
            element.querySelectorAll('p, ul, li'),
            (block) => ({ tag: block.tagName, text: block.textContent }),
          ),
        };
      });
    const before = await readDocument();
    const allText = before.chars.map((char) => char.text).join('');
    const from = allText.indexOf(scenario.start);
    const to = allText.indexOf(scenario.end, from) + scenario.end.length;
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    await editor.focus();
    // Use the browser selection on actual Note text, not a fixture editor or
    // mocked snapshot. Arrow counts vary at mark and list NodeView boundaries.
    await editor.evaluate(
      (element, { from, to }) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let offset = 0;
        const range = document.createRange();
        let started = false;
        while ((node = walker.nextNode())) {
          if (!node.parentElement?.closest('p')) continue;
          const end = offset + (node.textContent?.length ?? 0);
          if (!started && from >= offset && from < end) {
            range.setStart(node, from - offset);
            started = true;
          }
          if (started && to <= end) {
            range.setEnd(node, to - offset);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return;
          }
          offset = end;
        }
        throw new Error('Selection endpoints missing');
      },
      { from, to },
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.getSelection()?.toString().replace(/\s/g, ''),
        ),
      )
      .toBe(allText.slice(from, to).replace(/\s/g, ''));
    const trigger = page.getByRole('button', { name: 'Link', exact: true });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const form = page.getByRole('dialog', { name: 'Create link', exact: true });
    await expect(form).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: /^(Create|Edit) link$/ }),
    ).toHaveCount(1);
    await expect(form.getByLabel('Link URL')).toHaveValue('');
    await expect(form.getByLabel('Display text')).toBeFocused();
    await expect(form.getByLabel('Display text')).toHaveJSProperty(
      'readOnly',
      Boolean(scenario.crossBlock),
    );
    await expect(
      form.getByRole('button', { name: 'Remove link' }),
    ).toBeDisabled();
    await expect(
      form.getByRole('button', { name: 'Copy address' }),
    ).toBeDisabled();
    await form.getByLabel('Link URL').fill('https://example.com/relinked');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    await expect.poll(readDocument).toEqual({
      ...before,
      chars: before.chars.map((char, index) =>
        index >= from && index < to
          ? { ...char, href: 'https://example.com/relinked', title: null }
          : char,
      ),
    });
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(readDocument).toEqual(before);
  });
}

for (const backward of [false, true]) {
  test(`real NotePreview Chinese suffix native drag ${backward ? 'backward' : 'forward'} edits the full link and undoes`, async ({
    page,
  }) => {
    const original = 'https://weather.example';
    const note = await createCanvasNote(
      page,
      `来源：[中国天气网](${original} "Weather") · 上海市气象局`,
    );
    await note.dblclick();
    const editor = page.locator('.milkdown-note-preview .ProseMirror');
    await expect(editor).toBeVisible();
    await editor.click({ trial: true });
    const points = await editor.evaluate((element) => {
      const node = element.querySelector('a')?.firstChild;
      if (!node) throw new Error('Chinese link text missing');
      const range = document.createRange();
      range.setStart(node, 3);
      range.setEnd(node, 5);
      const rect = range.getBoundingClientRect();
      return {
        start: rect.left,
        end: rect.right,
        y: rect.top + rect.height / 2,
      };
    });
    await page.mouse.move(backward ? points.end : points.start, points.y);
    await page.mouse.down();
    await page.mouse.move(backward ? points.start : points.end, points.y, {
      steps: 12,
    });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('气网');
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Edit link', exact: true });
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Display text')).toHaveValue('中国天气网');
    await expect(form.getByLabel('Link URL')).toHaveValue(original);
    await expect(
      form.getByRole('button', { name: 'Copy address' }),
    ).toBeEnabled();
    await expect(
      form.getByRole('button', { name: 'Remove link' }),
    ).toBeEnabled();
    await form.getByLabel('Display text').fill('中国天气网站');
    await form.getByLabel('Link URL').fill('https://weather.example/updated');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(editor.locator('a')).toHaveCount(1);
    await expect(editor.locator('a')).toHaveText('中国天气网站');
    await expect(editor.locator('a')).toHaveAttribute(
      'href',
      'https://weather.example/updated',
    );
    await expect(editor.locator('a')).toHaveAttribute('title', 'Weather');
    await expect(editor.locator('p')).toHaveText(
      '来源：中国天气网站 · 上海市气象局',
    );
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('a')).toHaveText('中国天气网');
    await expect(editor.locator('a')).toHaveAttribute('href', original);
    await expect(editor.locator('p')).toHaveText(
      '来源：中国天气网 · 上海市气象局',
    );
  });
}

for (const selection of ['link', 'ordinary'] as const) {
  test(`real NotePreview native drag then toolbar Link with ${selection} selection`, async ({
    page,
  }) => {
    const note = await createCanvasNote(page);
    await note.dblclick();
    const editor = page.locator('.milkdown-note-preview .ProseMirror');
    await expect(editor).toBeVisible();
    await editor.click({ trial: true });
    const points = await editor.evaluate((element, selected) => {
      const node =
        selected === 'link'
          ? element.querySelector('a')?.firstChild
          : element.querySelector('p')?.firstChild;
      if (!node) throw new Error('Text missing');
      const range = document.createRange();
      range.setStart(node, 1);
      range.setEnd(node, selected === 'link' ? 15 : 5);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2, end: rect.right };
    }, selection);
    await page.mouse.move(points.x, points.y);
    await page.mouse.down();
    await page.mouse.move(points.end, points.y, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe(selection === 'link' ? 'riginal linked' : 'efor');
    await page
      .getByRole('button', { name: 'Link', exact: true })
      .click({ timeout: 10_000 });
    const form = page.getByRole('dialog', {
      name: selection === 'link' ? 'Edit link' : 'Create link',
      exact: true,
    });
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Display text')).toBeFocused();
  });
}

test('real canvas Note focused link opens once with Enter without a follow modifier', async ({
  page,
}) => {
  const opened = await observeNavigation(page);
  const note = await createCanvasNote(page);
  const anchor = note.locator('.ProseMirror a');
  await expect(anchor).toBeVisible();
  await expect(note.locator('.ProseMirror')).toHaveAttribute(
    'data-link-activation',
    'modifier',
  );
  await anchor.focus();
  await expect(anchor).toBeFocused();
  await page.keyboard.press('Enter');
  await expectNavigations(opened, 1);
  await settleBrowser(page);
  expect(opened).toHaveLength(1);
  await opened[0].close();
});

test('real canvas Note link selects its node, modifier opens, and dragging does not open', async ({
  page,
}) => {
  const opened = await observeNavigation(page);
  const note = await createCanvasNote(page);
  const anchor = note.locator('.ProseMirror a');
  await expect(note).toHaveCount(1);
  await expect(anchor).toBeVisible();
  await anchor.hover();
  await expect(anchor).not.toHaveCSS('cursor', 'pointer');
  const followKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  const otherKey = followKey === 'Meta' ? 'Control' : 'Meta';
  await page.keyboard.down(otherKey);
  await expect(anchor).not.toHaveCSS('cursor', 'pointer');
  await page.keyboard.up(otherKey);
  await page.keyboard.down(followKey);
  await expect(anchor).toHaveCSS('cursor', 'pointer');
  await page.keyboard.up(followKey);
  await expect(anchor).not.toHaveCSS('cursor', 'pointer');
  await page.keyboard.down(followKey);
  await expect(anchor).toHaveCSS('cursor', 'pointer');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(anchor).not.toHaveCSS('cursor', 'pointer');
  await page.keyboard.up(followKey);
  await expect(note.locator('.ProseMirror')).toHaveAttribute(
    'data-link-activation',
    'modifier',
  );
  // Clear creation's initial selection before proving that the link itself selects.
  const empty = await page.evaluate(() => {
    for (let y = 120; y < innerHeight - 100; y += 60) {
      for (let x = 160; x < innerWidth - 100; x += 60) {
        if (
          document
            .elementFromPoint(x, y)
            ?.classList.contains('react-flow__pane')
        )
          return { x, y };
      }
    }
    throw new Error('No unobstructed empty canvas point');
  });
  await page.mouse.click(empty.x, empty.y);
  await expect(note).not.toHaveClass(/selected/);
  await anchor.click();
  await expect(note).toHaveClass(/selected/);
  await settleBrowser(page);
  expect(opened).toHaveLength(0);
  await anchor.click({ modifiers: ['ControlOrMeta'] });
  await expectNavigations(opened, 1);
  await opened[0].close();
  await page.bringToFront();
  const before = await note.boundingBox();
  if (!before) throw new Error('Canvas note has no browser layout');
  // Start on unlinked note body so this is a canvas-node drag, not an anchor drag.
  const body = note.locator('.ProseMirror p').last();
  const bodyBox = await body.boundingBox();
  if (!bodyBox) throw new Error('Canvas note body has no browser layout');
  await page.mouse.move(bodyBox.x + 15, bodyBox.y + bodyBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bodyBox.x + 115, bodyBox.y + bodyBox.height / 2 + 60, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const after = await note.boundingBox();
      return after ? Math.hypot(after.x - before.x, after.y - before.y) : 0;
    })
    .toBeGreaterThan(50);
  await settleBrowser(page);
  expect(opened).toHaveLength(1);
});
