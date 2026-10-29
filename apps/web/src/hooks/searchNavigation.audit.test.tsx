// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InPreviewSearchBar } from '@/components/Panels/ExpandedNodePanel/InPreviewSearchBar';
import { usePreviewSearchStore } from '@/store/previewSearchStore';

import {
  findNthRange,
  scrollRangeIntoView,
  scheduleScrollToMatch,
} from './searchDom';
import { registerSearchSource, hashSearchSource } from './useSearchSource';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let host: HTMLDivElement;
let scope: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  scope = document.createElement('div');
  document.body.append(host, scope);
  root = createRoot(host);
  usePreviewSearchStore.getState().close();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  scope.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('search handoff lifecycle acceptance', () => {
  it('keeps a new handoff issued after disposal but before its replacement mounts', async () => {
    act(() =>
      root.render(<InPreviewSearchBar scopeEl={scope} nodeId="audit-node" />),
    );
    await act(async () => {
      root.unmount();
      usePreviewSearchStore.getState().reveal('audit-node', 'replacement', 1);
      await Promise.resolve();
    });
    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'audit-node',
      query: 'replacement',
      navigationRequest: { occurrenceIndex: 1 },
    });
  });
  it.each([false, true])(
    'preserves a cold asynchronous handoff under StrictMode (indexed: %s)',
    (requiresAdapter) => {
      usePreviewSearchStore.getState().reveal('audit-node', 'needle', 1);
      act(() =>
        root.render(
          <StrictMode>
            <InPreviewSearchBar
              scopeEl={scope}
              nodeId="audit-node"
              requiresAdapter={requiresAdapter}
            />
          </StrictMode>,
        ),
      );
      expect(usePreviewSearchStore.getState()).toMatchObject({
        isOpen: true,
        nodeId: 'audit-node',
        navigationRequest: { occurrenceIndex: 1 },
      });
    },
  );

  it('preserves the same cold handoff without StrictMode', () => {
    usePreviewSearchStore.getState().reveal('audit-node', 'needle', 1);
    act(() =>
      root.render(<InPreviewSearchBar scopeEl={scope} nodeId="audit-node" />),
    );
    expect(usePreviewSearchStore.getState().navigationRequest).not.toBeNull();
  });

  it('accepts a warm handoff after StrictMode replay has completed', () => {
    act(() =>
      root.render(
        <StrictMode>
          <InPreviewSearchBar scopeEl={scope} nodeId="audit-node" />
        </StrictMode>,
      ),
    );
    act(() =>
      usePreviewSearchStore.getState().reveal('audit-node', 'needle', 1),
    );
    expect(usePreviewSearchStore.getState().navigationRequest).not.toBeNull();
  });

  it('does not let an older renderer for the same node erase a newer pending handoff', async () => {
    const previousHost = document.createElement('div');
    document.body.append(previousHost);
    const previousRoot = createRoot(previousHost);
    act(() =>
      previousRoot.render(
        <InPreviewSearchBar
          scopeEl={scope}
          nodeId="audit-node"
          requiresAdapter
        />,
      ),
    );
    act(() =>
      root.render(
        <InPreviewSearchBar
          scopeEl={scope}
          nodeId="audit-node"
          requiresAdapter
        />,
      ),
    );
    act(() =>
      usePreviewSearchStore.getState().reveal('audit-node', 'new query', 1),
    );
    await act(async () => previousRoot.unmount());
    previousHost.remove();
    expect(usePreviewSearchStore.getState()).toMatchObject({
      nodeId: 'audit-node',
      query: 'new query',
      navigationRequest: { occurrenceIndex: 1 },
    });
  });
});

describe('source-to-rendered addressing', () => {
  const markdown = '[needle](https://example.test/needle)\n\nParagraph needle';
  const geometry = (): void => {
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(10, 100, 80, 20),
    );
  };

  it.each(['', 'abc', '中文 \u0130 ΟΣ 😀\n'])(
    'hashes %j without crypto.subtle using the server digest',
    async (text) => {
      vi.stubGlobal('crypto', {});
      expect(await hashSearchSource(text)).toBe(
        createHash('sha256').update(text).digest('hex'),
      );
    },
  );

  it('registers and reveals contextual Unicode matches on ordinary HTTP', async () => {
    vi.stubGlobal('crypto', {});
    geometry();
    const text = '\u0130 ΟΣ';
    scope.textContent = text;
    const unregister = registerSearchSource(scope, text, 'text');
    const onMatch = vi.fn();
    const cancel = scheduleScrollToMatch(() => scope, 'ς', 0, {
      source: {
        hash: createHash('sha256').update(text).digest('hex'),
        offset: 3,
        length: 1,
      },
      onMatch,
    });
    await vi.waitFor(() => expect(onMatch).toHaveBeenCalledTimes(1));
    expect(onMatch.mock.calls[0]?.[0].toString()).toBe('Σ');
    cancel();
    unregister();
  });

  it('waits for an editor-model readiness signal even when its text DOM already exists', async () => {
    geometry();
    scope.textContent = 'needle';
    let ready = false;
    const unregister = registerSearchSource(scope, 'needle', 'markdown', () =>
      ready ? findNthRange(scope, 'needle', 0) : null,
    );
    const onMatch = vi.fn();
    const cancel = scheduleScrollToMatch(() => scope, 'needle', 0, {
      source: { hash: await hashSearchSource('needle'), offset: 0 },
      onMatch,
    });
    expect(onMatch).not.toHaveBeenCalled();
    ready = true;
    scope.setAttribute('data-search-source-ready', '');
    await vi.waitFor(() => expect(onMatch).toHaveBeenCalledTimes(1));
    cancel();
    unregister();
  });
  it('reports a hidden link destination instead of selecting a later visible occurrence', async () => {
    geometry();
    scope.innerHTML = '<p><a>needle</a></p><p>Paragraph needle</p>';
    const unregister = registerSearchSource(scope, markdown, 'markdown');
    const onMatch = vi.fn();
    const onTimeout = vi.fn();
    const cancel = scheduleScrollToMatch(() => scope, 'needle', 1, {
      source: {
        hash: await hashSearchSource(markdown),
        offset: markdown.indexOf('needle', markdown.indexOf('https')),
      },
      onMatch,
      onTimeout,
    });
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledExactlyOnceWith());
    expect(onMatch).not.toHaveBeenCalled();
    cancel();
    unregister();
  });

  it('reveals the visible paragraph after a hidden link occurrence with its rendered counter', async () => {
    geometry();
    scope.innerHTML = '<p><a>needle</a></p><p>Paragraph needle</p>';
    const unregister = registerSearchSource(scope, markdown, 'markdown');
    const source = {
      hash: await hashSearchSource(markdown),
      offset: markdown.lastIndexOf('needle'),
    };
    act(() => {
      usePreviewSearchStore
        .getState()
        .reveal('audit-node', 'needle', 2, source);
      root.render(<InPreviewSearchBar scopeEl={scope} nodeId="audit-node" />);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(usePreviewSearchStore.getState().navigationRequest).toBeNull(),
      );
    });
    expect(host.textContent).toContain('2/2');
    unregister();
  });

  it('selects the originating assistant paragraph, never an unrelated later user message', async () => {
    geometry();
    scope.innerHTML =
      '<div data-assistant><p><a>needle</a></p><p data-target>Paragraph needle</p></div><span data-later-user>Unrelated later needle</span>';
    const assistant = scope.querySelector<HTMLElement>('[data-assistant]');
    const laterUser = scope.querySelector<HTMLElement>('[data-later-user]');
    if (!assistant || !laterUser) throw new Error('Missing source fixture');
    const unregister = registerSearchSource(assistant, markdown, 'markdown');
    const unregisterUser = registerSearchSource(
      laterUser,
      'Unrelated later needle',
      'text',
    );
    const onMatch = vi.fn();
    const cancel = scheduleScrollToMatch(() => scope, 'needle', 2, {
      source: {
        hash: await hashSearchSource(markdown),
        offset: markdown.lastIndexOf('needle'),
      },
      onMatch,
    });
    await vi.waitFor(() => expect(onMatch).toHaveBeenCalledTimes(1));
    expect(
      onMatch.mock.calls[0]?.[0].startContainer.parentElement?.hasAttribute(
        'data-target',
      ),
    ).toBe(true);
    cancel();
    unregister();
    unregisterUser();
  });

  it('rejects ambiguous identical sources rather than choosing one message', async () => {
    geometry();
    scope.innerHTML = '<p>needle</p><p>needle</p>';
    const unregister = Array.from(scope.children, (element) =>
      registerSearchSource(element as HTMLElement, 'needle', 'text'),
    );
    const onMatch = vi.fn();
    const onTimeout = vi.fn();
    const hash = await hashSearchSource('needle');
    // Hash registration is asynchronous; establish ambiguity before navigating.
    await vi.waitFor(() =>
      expect(
        Array.from(scope.children, (element) =>
          element.getAttribute('data-search-source'),
        ),
      ).toEqual([hash, hash]),
    );
    const cancel = scheduleScrollToMatch(() => scope, 'needle', 1, {
      source: { hash, offset: 0 },
      onMatch,
      onTimeout,
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onMatch).not.toHaveBeenCalled();
    cancel();
    unregister.forEach((cleanup) => cleanup());
  });

  it('maps a PDF phrase across separate text-layer spans without requiring DOM spaces', async () => {
    const { findProjectedRange } = await import('./searchDom');
    scope.innerHTML = '<span>needle</span><span>phrase</span>';
    expect(findProjectedRange(scope, 'needle phrase', 0, 13)?.toString()).toBe(
      'needlephrase',
    );
    expect(findProjectedRange(scope, 'different phrase', 0, 9)).toBeNull();
  });
});

it('makes the matched range visible inside a paragraph taller than its scroll panel', () => {
  scope.style.overflowY = 'auto';
  const paragraph = document.createElement('p');
  paragraph.textContent = 'filler '.repeat(1000) + 'needle';
  scope.append(paragraph);
  const range = findNthRange(paragraph, 'needle', 0);
  if (!range) throw new Error('Missing fixture occurrence');
  vi.spyOn(scope, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 300, 200),
  );
  vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, -scope.scrollTop, 300, 2000),
  );
  vi.spyOn(range, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 1960 - scope.scrollTop, 80, 20),
  );
  vi.spyOn(paragraph, 'scrollIntoView').mockImplementation(() => {
    scope.scrollTop = 900;
  });
  scrollRangeIntoView(range);
  const after = range.getBoundingClientRect();
  expect(after.top).toBeGreaterThanOrEqual(0);
  expect(after.bottom).toBeLessThanOrEqual(200);
});
