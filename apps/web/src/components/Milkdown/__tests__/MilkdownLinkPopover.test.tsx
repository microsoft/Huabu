// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from '@/utils/io/clipboard';

import {
  createMilkdown,
  type MilkdownInstance,
  type MilkdownLinkSnapshot,
} from '../createMilkdown';
import { MilkdownEditor } from '../MilkdownEditor';
import { MilkdownFloatingToolbar } from '../MilkdownFloatingToolbar';
import { MilkdownLinkPopover } from '../MilkdownLinkPopover';

import type * as ClipboardModule from '@/utils/io/clipboard';

vi.mock('@/utils/io/clipboard', async (importOriginal) => ({
  ...(await importOriginal<typeof ClipboardModule>()),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let instance: MilkdownInstance;
let editorRoot: HTMLDivElement;
let reactRoot: Root | null;
let chromeRoot: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  act(() => reactRoot?.unmount());
  reactRoot = null;
  await instance?.destroy();
  editorRoot?.remove();
  chromeRoot?.remove();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(
  markdown = '[hello **bold** tail](https://example.com "Title") and [same](https://other.example)',
  chrome = false,
) {
  editorRoot = document.createElement('div');
  document.body.append(editorRoot);
  instance = await createMilkdown({
    root: editorRoot,
    initialMarkdown: markdown,
    toolbarMode: 'none',
    linkActivation: 'plain',
    onLinkClick: vi.fn(),
  });
  if (chrome) {
    chromeRoot = document.createElement('div');
    document.body.append(chromeRoot);
    reactRoot = createRoot(chromeRoot);
    act(() =>
      reactRoot?.render(
        <MilkdownLinkPopover
          instance={instance}
          rootRef={{ current: editorRoot }}
        />,
      ),
    );
  }
}

function anchor(index = 0): HTMLAnchorElement {
  const el =
    editorRoot.querySelectorAll<HTMLAnchorElement>('.ProseMirror a')[index];
  if (!el) throw new Error('Missing anchor');
  return el;
}
function snapshot(index = 0): MilkdownLinkSnapshot {
  const value = instance.getLinkSnapshot(anchor(index));
  if (!value) throw new Error('Missing snapshot');
  return value;
}
function hover() {
  act(() =>
    anchor().dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    ),
  );
}
function dialog() {
  return document.querySelector('[role="dialog"]');
}
function button(label: string): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find(
    (el) => el.textContent === `editor.${label}`,
  );
  if (!el) throw new Error(`Missing button ${label}`);
  return el;
}
function shortcut(
  target: Element,
  modifier: 'metaKey' | 'ctrlKey' = 'metaKey',
) {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    [modifier]: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  return event;
}
function input(index: number, value: string) {
  const el = dialog()?.querySelectorAll('input')[index];
  if (!el) throw new Error('Missing dialog input');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Milkdown link edit snapshots (real editor)', () => {
  it.each([
    ['suffix at right boundary', '中国天气网', '气网', '气网'],
    ['middle', '中国天气网', '国天', '国天'],
    ['prefix', '中国天气网', '中国', '中国'],
    ['suffix inside a mixed-mark run', '中国**天气网**', '气网', '气网'],
    ['across mixed marks', '中**国天气**网', '天气', '网'],
  ])(
    'captures the full Chinese link from %s',
    async (_name, label, from, to) => {
      await mount(
        `来源：[${label}](https://weather.example "Weather") · 上海市气象局`,
      );
      instance.__selectTextBetweenForTest?.(from, to);
      const selected = instance.getSelectionRange();
      const captured = instance.getLinkSnapshot();
      expect(captured).toMatchObject({
        kind: 'link',
        text: '中国天气网',
        href: 'https://weather.example',
        range: { from: 4, to: 9 },
      });
      expect(instance.getSelectionRange()).toEqual(selected);
      expect(instance.getActiveLink()).toMatchObject({
        href: 'https://weather.example',
        range: { from: 4, to: 9 },
      });
      if (!captured) throw new Error('Missing Chinese link snapshot');
      expect(
        instance.editLink(captured, 'https://weather.example/updated'),
      ).toBe(true);
      expect(instance.getMarkdown()).toContain(
        `来源：[${label}](https://weather.example/updated "Weather") · 上海市气象局`,
      );
    },
  );

  it.each([
    ['different addresses', 'https://other.example', 'Weather'],
    ['different titles', 'https://weather.example', 'Other'],
  ])(
    'keeps adjacent Chinese links with %s distinct',
    async (_name, secondHref, secondTitle) => {
      await mount(
        `来源：[中国天气网](https://weather.example "Weather")[上海市气象局](${secondHref} "${secondTitle}")`,
      );
      instance.__selectTextBetweenForTest?.('气网', '气网');
      expect(instance.getLinkSnapshot()).toMatchObject({
        kind: 'link',
        text: '中国天气网',
        href: 'https://weather.example',
        range: { from: 4, to: 9 },
      });
      instance.__selectTextBetweenForTest?.('上海', '上海');
      expect(instance.getLinkSnapshot()).toMatchObject({
        kind: 'link',
        text: '上海市气象局',
        href: secondHref,
        range: { from: 9, to: 15 },
      });
      instance.__selectTextBetweenForTest?.('气网', '上海');
      expect(instance.getLinkSnapshot()).toMatchObject({
        kind: 'selection',
        text: '气网上海',
        href: '',
        range: instance.getSelectionRange(),
      });
    },
  );

  it('creates a renamed label while retaining its bold formatting', async () => {
    await mount('**ordinary**');
    instance.__selectAllTextForTest?.();
    const captured = instance.getLinkSnapshot();
    if (!captured) throw new Error('Missing selection snapshot');
    expect(instance.editLink(captured, 'https://new.example', 'renamed')).toBe(
      true,
    );
    expect(editorRoot.querySelector('.ProseMirror strong')?.textContent).toBe(
      'renamed',
    );
    expect(snapshot()).toMatchObject({
      text: 'renamed',
      href: 'https://new.example',
    });
  });

  it('creates from mixed-mark plain text in one transaction and preserves formatting', async () => {
    await mount('hello **bold** tail');
    instance.__selectAllTextForTest?.();
    const captured = instance.getLinkSnapshot();
    expect(captured).toMatchObject({
      kind: 'selection',
      text: 'hello bold tail',
      textEditable: true,
    });
    if (!captured) throw new Error('Missing selection snapshot');
    const updates = vi.fn();
    instance.onMarkdownUpdated(updates);
    expect(instance.editLink(captured, 'https://new.example')).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    expect(snapshot().text).toBe('hello bold tail');
  });

  it('marks a cross-block selection without flattening paragraphs or list items', async () => {
    await mount(
      'first **[bold](https://first.example)**\n\n- [second](https://second.example)\n- third',
    );
    instance.__selectTextBetweenForTest?.('first', 'third');
    const captured = instance.getLinkSnapshot();
    expect(captured).toMatchObject({
      kind: 'selection',
      href: '',
      textEditable: false,
    });
    if (!captured) throw new Error('Missing selection snapshot');
    const before = instance.getMarkdown();
    const paragraphs = editorRoot.querySelectorAll('.ProseMirror p').length;
    expect(
      instance.editLink(captured, 'https://new.example', 'flattened'),
    ).toBe(false);
    expect(instance.getMarkdown()).toBe(before);
    expect(instance.editLink(captured, 'https://new.example')).toBe(true);
    expect(editorRoot.querySelectorAll('.ProseMirror li')).toHaveLength(2);
    expect(editorRoot.querySelectorAll('.ProseMirror p')).toHaveLength(
      paragraphs,
    );
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    expect(editorRoot.querySelectorAll('.ProseMirror a')).toHaveLength(4);
  });

  it('expands only a selection wholly inside one link, capturing mixed or multiple links as creation', async () => {
    await mount(
      '[first link](https://example.com) plain [second](https://other.example)',
    );
    instance.__selectTextBetweenForTest?.('first', 'first');
    expect(instance.getLinkSnapshot()).toMatchObject({
      kind: 'link',
      text: 'first link',
    });
    instance.__selectTextBetweenForTest?.('first', 'plain');
    expect(instance.getLinkSnapshot()).toMatchObject({
      kind: 'selection',
      href: '',
      text: 'first link plain',
      range: instance.getSelectionRange(),
    });
    instance.__selectTextBetweenForTest?.('first', 'second');
    expect(instance.getLinkSnapshot()).toMatchObject({
      kind: 'selection',
      href: '',
      text: 'first link plain second',
      range: instance.getSelectionRange(),
    });
    // Explicit anchor targeting remains independent of the selected range.
    expect(snapshot().text).toBe('first link');
  });

  it.each([
    ['plain to partial link', 'plain', 'bold'],
    ['partial link to plain', 'bold', 'gap'],
    ['partial links with different URLs', 'bold', 'second'],
  ])('relinks only selected runs: %s', async (_name, from, to) => {
    await mount(
      'plain [left **bold** end](https://first.example "First") gap [second right](https://second.example "Second") [outside](https://outside.example "Outside")',
    );
    instance.__selectTextBetweenForTest?.(from, to);
    const captured = instance.getLinkSnapshot();
    expect(captured).toMatchObject({
      kind: 'selection',
      href: '',
      range: instance.getSelectionRange(),
    });
    if (!captured) throw new Error('Missing mixed selection snapshot');
    const before = instance.getMarkdown();
    const content = editorRoot.querySelector('.ProseMirror')?.textContent;
    const updates = vi.fn();
    instance.onMarkdownUpdated(updates);
    expect(instance.editLink(captured, 'https://new.example')).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(editorRoot.querySelector('.ProseMirror')?.textContent).toBe(content);
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    expect(
      Array.from(
        editorRoot.querySelectorAll('a[href="https://new.example"]'),
        (el) => el.textContent,
      ).join(''),
    ).toBe(captured.text);
    expect(instance.getMarkdown()).toContain(
      '[outside](https://outside.example "Outside")',
    );
    if (from === 'bold')
      expect(
        editorRoot.querySelector('a[href="https://first.example"]')
          ?.textContent,
      ).toBe('left ');
    if (to === 'bold')
      expect(
        editorRoot.querySelector('a[href="https://first.example"]')
          ?.textContent,
      ).toBe(' end');
    if (to === 'second')
      expect(
        editorRoot.querySelector('a[href="https://second.example"]')
          ?.textContent,
      ).toBe(' right');
    instance.focus();
    act(() =>
      editorRoot.querySelector('.ProseMirror')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(instance.getMarkdown()).toBe(before);
  });

  it('relinks adjacent links with different addresses or titles without borrowing either title', async () => {
    await mount(
      '[one](https://first.example "First")[two](https://second.example "Second")[three](https://second.example "Third")',
    );
    instance.__selectTextBetweenForTest?.('one', 'three');
    const captured = instance.getLinkSnapshot();
    expect(captured).toMatchObject({
      kind: 'selection',
      href: '',
      text: 'onetwothree',
    });
    if (!captured) throw new Error('Missing multi-link snapshot');
    expect(instance.editLink(captured, 'https://new.example')).toBe(true);
    expect(instance.getMarkdown().trim()).toBe(
      '[onetwothree](https://new.example)',
    );
  });

  it.each([
    '![image](https://example.com/image.png) ordinary',
    '`code` ordinary',
    '```\ncode\n```\n\nordinary',
  ])('rejects unsupported text selections: %s', async (markdown) => {
    await mount(markdown);
    instance.__selectAllTextForTest?.();
    expect(instance.getLinkSnapshot()).toBeNull();
  });

  it('rejects a node selection even when its block contains linkable text', async () => {
    await mount('ordinary');
    instance.__selectCurrentBlockForTest?.();
    expect(instance.getLinkSnapshot()).toBeNull();
  });

  it('rejects stale creation snapshots while retaining them across caret changes', async () => {
    await mount('ordinary text');
    instance.__selectAllTextForTest?.();
    const captured = instance.getLinkSnapshot();
    if (!captured) throw new Error('Missing selection snapshot');
    instance.__setCursorAfterTextForTest?.('ordinary');
    expect(instance.isLinkSnapshotCurrent(captured)).toBe(true);
    instance.setMarkdown('ordinary text changed');
    expect(instance.editLink(captured, 'https://new.example')).toBe(false);
    expect(editorRoot.querySelector('.ProseMirror a')).toBeNull();
  });

  it('does not offer destructive linking of code or an empty unlinked caret', async () => {
    await mount('`code` plain');
    instance.__selectAllTextForTest?.();
    expect(instance.getLinkSnapshot()).toBeNull();
    instance.__setCursorAfterTextForTest?.('plain');
    expect(instance.getLinkSnapshot()).toBeNull();
  });

  it('retains formatting when replacing an entirely bold link label', async () => {
    await mount('**[old](https://example.com "Title")**');
    expect(instance.editLink(snapshot(), 'https://new.example', 'new')).toBe(
      true,
    );
    expect(editorRoot.querySelector('strong')?.textContent).toBe('new');
    expect(instance.getMarkdown()).toContain('"Title"');
  });
  it('captures the full mark across bold runs without moving selection', async () => {
    await mount();
    instance.__setCursorAfterTextForTest?.('same');
    const selection = instance.getSelectionRange(true);
    expect(snapshot()).toMatchObject({
      text: 'hello bold tail',
      href: 'https://example.com',
    });
    expect(instance.getSelectionRange(true)).toEqual(selection);
    expect(
      snapshot(editorRoot.querySelectorAll('.ProseMirror a').length - 1).text,
    ).toBe('same');
  });

  it('edits text and URL atomically while retaining title and unchanged bold runs', async () => {
    await mount();
    const updates = vi.fn();
    instance.onMarkdownUpdated(updates);
    expect(
      instance.editLink(snapshot(), 'https://new.example', 'hello bold ending'),
    ).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(snapshot()).toMatchObject({
      text: 'hello bold ending',
      href: 'https://new.example',
    });
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    expect(instance.getMarkdown()).toContain('"Title"');
    expect(instance.getMarkdown()).toContain('[same](https://other.example)');
  });

  it('preserves all other marks when only changing URL or removing a link', async () => {
    await mount();
    expect(instance.editLink(snapshot(), 'https://new.example')).toBe(true);
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    expect(instance.getMarkdown()).toContain('"Title"');
    expect(instance.editLink(snapshot(), null)).toBe(true);
    expect(instance.getMarkdown()).toContain('hello **bold** tail');
    expect(editorRoot.querySelectorAll('.ProseMirror a')).toHaveLength(1);
  });

  it('retains a snapshot across selection-only transactions', async () => {
    await mount();
    const captured = snapshot();
    const updates = vi.fn();
    instance.onMarkdownUpdated(updates);
    instance.__setCursorAfterTextForTest?.('same');
    expect(updates).not.toHaveBeenCalled();
    expect(instance.isLinkSnapshotCurrent(captured)).toBe(true);
    expect(instance.editLink(captured, 'https://new.example')).toBe(true);
  });

  it('rejects stale equal text at the same positions and elsewhere, and forged snapshots', async () => {
    await mount('[same](https://example.com) after');
    const captured = snapshot();
    instance.setMarkdown(
      '[same](https://example.com) elsewhere [same](https://example.com)',
    );
    const markdown = instance.getMarkdown();
    expect(instance.isLinkSnapshotCurrent(captured)).toBe(false);
    expect(instance.editLink(captured, null)).toBe(false);
    expect(instance.editLink({ ...snapshot() }, null)).toBe(false);
    expect(instance.getMarkdown()).toBe(markdown);
  });

  it('rejects unsafe addresses, empty labels and read-only writes', async () => {
    await mount();
    const captured = snapshot();
    expect(instance.editLink(captured, 'javascript:alert(1)')).toBe(false);
    expect(instance.editLink(captured, 'https://new.example', '')).toBe(false);
    instance.setReadonly(true);
    expect(instance.editLink(captured, null)).toBe(false);
    expect(instance.isLinkSnapshotCurrent(captured)).toBe(true);
  });

  it('does not merge adjacent links with different titles or addresses', async () => {
    await mount(
      '[one](https://example.com "first")[two](https://example.com "second")[three](https://other.example)',
    );
    expect(snapshot(0).text).toBe('one');
    expect(snapshot(1).text).toBe('two');
    expect(snapshot(2).text).toBe('three');
  });
});

describe('MilkdownLinkPopover (real editor and Common controls)', () => {
  it('disables toolbar Link for rejected selections and re-enables it for a supported target', async () => {
    await mount('[linked](https://example.com) ordinary `code`', true);
    instance.__selectTextBetweenForTest?.('linked', 'code');
    vi.spyOn(instance, 'getSelectionClientRect').mockReturnValue(
      new DOMRect(20, 100, 120, 20),
    );
    act(() =>
      reactRoot?.render(
        <>
          <MilkdownLinkPopover
            instance={instance}
            rootRef={{ current: editorRoot }}
          />
          <MilkdownFloatingToolbar
            instance={instance}
            surfaceRef={{ current: editorRoot }}
          />
        </>,
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="editor.link"]',
    );
    if (!trigger) throw new Error('Missing toolbar link button');
    expect(instance.getLinkSnapshot()).toBeNull();
    expect(trigger.disabled).toBe(true);
    act(() => trigger.click());
    expect(dialog()).toBeNull();
    act(() => instance.__selectTextBetweenForTest?.('linked', 'ordinary'));
    expect(trigger.disabled).toBe(false);
    act(() => trigger.click());
    expect(dialog()?.getAttribute('aria-label')).toBe('editor.createLink');
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    act(() => instance.__selectTextBetweenForTest?.('linked', 'linked'));
    expect(trigger.disabled).toBe(false);
    act(() => trigger.click());
    expect(dialog()?.getAttribute('aria-label')).toBe('editor.editLink');
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    act(() => instance.__selectTextBetweenForTest?.('code', 'code'));
    expect(trigger.disabled).toBe(true);
    act(() => instance.__setCursorAfterTextForTest?.('ordinary'));
    expect(trigger.disabled).toBe(true);
  });

  it('uses the actual toolbar and shortcut to create with the same single panel', async () => {
    await mount('ordinary **bold** text', true);
    instance.__selectAllTextForTest?.();
    const selection = instance.getSelectionRange();
    vi.spyOn(instance, 'getSelectionClientRect').mockReturnValue(
      new DOMRect(20, 100, 120, 20),
    );
    act(() =>
      reactRoot?.render(
        <>
          <MilkdownLinkPopover
            instance={instance}
            rootRef={{ current: editorRoot }}
          />
          <MilkdownFloatingToolbar
            instance={instance}
            surfaceRef={{ current: editorRoot }}
          />
        </>,
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="editor.link"]',
    );
    if (!trigger) throw new Error('Missing toolbar link button');
    act(() => trigger.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog()?.getAttribute('aria-label')).toBe('editor.createLink');
    expect(dialog()?.querySelector('input')?.value).toBe('ordinary bold text');
    expect(
      document.querySelector('input[placeholder="https://example.com"]'),
    ).toBeNull();
    expect(button('copyLinkAddress').disabled).toBe(true);
    expect(button('removeLink').disabled).toBe(true);
    act(() => vi.advanceTimersToNextFrame());
    act(() => instance.__selectTextBetweenForTest?.('text', 'text'));
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(instance.getSelectionRange()).toEqual(selection);
    expect(document.activeElement).toBe(
      editorRoot.querySelector('.ProseMirror'),
    );
    // A shortcut from the portalled toolbar belongs to this editor too.
    act(() => trigger.focus());
    expect(shortcut(trigger).defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    input(1, 'https://new.example');
    act(() => button('saveLink').click());
    expect(dialog()).toBeNull();
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    act(() => trigger.click());
    expect(dialog()?.getAttribute('aria-label')).toBe('editor.editLink');
    expect(dialog()?.querySelectorAll('input')[1]?.value).toBe(
      'https://new.example',
    );
  });

  it('explicit selection requests replace hover targets and subsequent hover cannot retarget them', async () => {
    await mount('[hover](https://example.com) ordinary text', true);
    hover();
    act(() => instance.__selectTextBetweenForTest?.('ordinary', 'text'));
    expect(dialog()?.querySelector('input')?.value).toBe('hover');
    act(() => instance.requestLinkEdit());
    expect(dialog()?.querySelector('input')?.value).toBe('ordinary text');
    hover();
    expect(dialog()?.querySelector('input')?.value).toBe('ordinary text');
    input(1, 'https://new.example');
    act(() => button('saveLink').click());
    expect(snapshot().href).toBe('https://example.com');
    expect(snapshot(1)).toMatchObject({
      href: 'https://new.example',
      text: 'ordinary text',
    });
  });

  it('dismisses stale selected text without allowing a late save', async () => {
    await mount('ordinary text', true);
    instance.__selectAllTextForTest?.();
    act(() => instance.requestLinkEdit());
    const save = button('saveLink');
    input(1, 'https://new.example');
    act(() => instance.setMarkdown('replacement text'));
    expect(dialog()).toBeNull();
    act(() => save.click());
    expect(instance.getMarkdown().trim()).toBe('replacement text');
  });

  it('does not reopen on replacement pointerover until the pointer actually moves', async () => {
    await mount('[hello](https://example.com)', true);
    hover();
    input(1, 'https://new.example');
    act(() =>
      dialog()?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(dialog()).toBeNull();
    hover();
    expect(dialog()).toBeNull();
    act(() =>
      anchor().dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 20,
          clientY: 30,
        }),
      ),
    );
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelectorAll('input')[1]?.value).toBe(
      'https://new.example',
    );
  });

  it.each([
    {
      editable: true,
      callback: true,
      activation: 'plain' as const,
      visible: true,
    },
    {
      editable: true,
      callback: false,
      activation: 'plain' as const,
      visible: true,
    },
    {
      editable: true,
      callback: true,
      activation: 'modifier' as const,
      visible: true,
    },
    {
      editable: false,
      callback: true,
      activation: 'plain' as const,
      visible: false,
    },
  ])(
    'mounts controls for editable editors independently of navigation: %j',
    async ({ editable, callback, activation, visible }) => {
      chromeRoot = document.createElement('div');
      document.body.append(chromeRoot);
      reactRoot = createRoot(chromeRoot);
      let ready: (() => void) | undefined;
      const mounted = new Promise<void>((resolve) => {
        ready = resolve;
      });
      await act(async () => {
        reactRoot?.render(
          <MilkdownEditor
            markdown="[hello](https://example.com)"
            editable={editable}
            onLinkClick={callback ? vi.fn() : undefined}
            linkActivation={activation}
            onReady={(value) => {
              if (value) {
                instance = value;
                ready?.();
              }
            }}
          />,
        );
      });
      await act(async () => {
        await mounted;
      });
      const link = chromeRoot.querySelector('a');
      if (!link) throw new Error('Missing mounted link');
      act(() =>
        link.dispatchEvent(
          new PointerEvent('pointerover', {
            bubbles: true,
            pointerType: 'mouse',
          }),
        ),
      );
      expect(Boolean(dialog())).toBe(visible);
    },
  );
  it('opens on hover without focus or selection theft and dismisses on Escape', async () => {
    await mount(undefined, true);
    instance.focus();
    const focused = document.activeElement;
    const selection = instance.getSelectionRange(true);
    hover();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(focused);
    expect(instance.getSelectionRange(true)).toEqual(selection);
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(focused);
  });

  it.each(['metaKey', 'ctrlKey'] as const)(
    'enters from the caret with %s+K and restores editor focus',
    async (modifier) => {
      await mount(undefined, true);
      instance.__setCursorAfterTextForTest?.('hello');
      instance.focus();
      const focused = document.activeElement;
      if (!focused) throw new Error('Missing editor focus');
      expect(shortcut(focused, modifier).defaultPrevented).toBe(true);
      act(() => vi.advanceTimersToNextFrame());
      expect(document.activeElement).toBe(dialog()?.querySelector('input'));
      act(() =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      );
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(focused);
    },
  );

  it('enters from a focused anchor without moving editor selection', async () => {
    await mount(undefined, true);
    instance.__setCursorAfterTextForTest?.('same');
    const selection = instance.getSelectionRange(true);
    anchor().focus();
    shortcut(anchor());
    expect(dialog()?.querySelector('input')?.value).toBe('hello bold tail');
    expect(instance.getSelectionRange(true)).toEqual(selection);
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(document.activeElement).toBe(anchor());
  });

  it('keeps controls traversable across the hover gap and inside the form', async () => {
    await mount(undefined, true);
    hover();
    act(() =>
      anchor().dispatchEvent(new PointerEvent('pointerout', { bubbles: true })),
    );
    act(() => dialog()?.querySelector('input')?.focus());
    act(() => vi.advanceTimersByTime(250));
    expect(dialog()).not.toBeNull();
    act(() => button('saveLink').focus());
    expect(dialog()).not.toBeNull();
  });

  it('shows a URL validation error without changing content, then saves both fields', async () => {
    await mount(undefined, true);
    hover();
    const markdown = instance.getMarkdown();
    input(1, 'javascript:alert(1)');
    act(() => button('saveLink').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'editor.linkInvalidUrl',
    );
    expect(instance.getMarkdown()).toBe(markdown);
    input(0, 'hello bold edited');
    input(1, 'https://new.example');
    act(() => button('saveLink').click());
    expect(snapshot()).toMatchObject({
      text: 'hello bold edited',
      href: 'https://new.example',
    });
    expect(editorRoot.querySelector('strong')?.textContent).toBe('bold');
    expect(instance.getMarkdown()).toContain('"Title"');
    expect(dialog()).toBeNull();
  });

  it('copies the captured address and removes only the link', async () => {
    await mount(undefined, true);
    hover();
    await act(async () => button('copyLinkAddress').click());
    expect(copyToClipboard).toHaveBeenCalledWith('https://example.com');
    expect(button('linkCopied')).toBeTruthy();
    act(() => button('removeLink').click());
    expect(instance.getMarkdown()).toContain('hello **bold** tail');
    expect(dialog()).toBeNull();
  });

  it('closes for content changes but not selection-only updates', async () => {
    await mount(undefined, true);
    hover();
    act(() => instance.__setCursorAfterTextForTest?.('same'));
    expect(dialog()).not.toBeNull();
    act(() =>
      instance.setMarkdown('[hello bold tail](https://example.com) changed'),
    );
    expect(dialog()).toBeNull();
  });
});
