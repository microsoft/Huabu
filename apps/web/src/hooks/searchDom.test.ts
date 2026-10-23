// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findNthRange,
  findRanges,
  scheduleScrollToMatch,
  scrollRangeIntoView,
} from './searchDom';

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.style.display = 'block';
  root.style.visibility = 'visible';
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 100, 80, 20),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('preview DOM search boundaries', () => {
  it('reveals conversation history before resolving an ordinal inside a scoped message', async () => {
    const root = rootWith('<p data-id="recent">recent needle needle</p>');
    root.setAttribute('data-chat-thread-root', '');
    root.setAttribute('data-chat-has-older', 'true');
    root.addEventListener('chat-reveal-search', (event) =>
      event.preventDefault(),
    );
    const getMatchRoot = vi.fn(() =>
      root.querySelector<HTMLElement>('[data-id="recent"]'),
    );
    const onMatch = vi.fn();
    const scroll = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const cancel = scheduleScrollToMatch(() => root, 'needle', 1, {
      getMatchRoot,
      onMatch,
    });
    expect(getMatchRoot).not.toHaveBeenCalled();
    root.insertAdjacentHTML(
      'afterbegin',
      '<p data-id="older">older needle needle</p>',
    );
    root.removeAttribute('data-chat-has-older');
    await vi.waitFor(() => expect(onMatch).toHaveBeenCalledTimes(1));
    expect(
      onMatch.mock.calls[0]?.[0].startContainer.parentElement?.dataset.id,
    ).toBe('recent');
    cancel();
    scroll.mockRestore();
    root.remove();
  });

  it('reports a missing or ambiguous originating prompt without using the full thread', async () => {
    const root = rootWith('unrelated needle');
    root.setAttribute('data-chat-thread-root', '');
    root.addEventListener('chat-reveal-search', (event) =>
      event.preventDefault(),
    );
    const onMatch = vi.fn();
    const onTimeout = vi.fn();
    const cancel = scheduleScrollToMatch(() => root, 'needle', 0, {
      getMatchRoot: () => null,
      onMatch,
      onTimeout,
      timeoutMs: 10,
    });
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1));
    expect(onMatch).not.toHaveBeenCalled();
    cancel();
    root.remove();
  });
  it('scrolls a match hidden below an inner panel even when it is inside the browser viewport', () => {
    const root = rootWith('needle');
    root.style.overflowY = 'auto';
    const range = findNthRange(root, 'needle', 0);
    if (!range) throw new Error('Missing fixture match');
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 100, 300, 200),
    );
    vi.spyOn(range, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 350 - root.scrollTop, 100, 20),
    );
    expect(scrollRangeIntoView(range)).toBe(true);
    expect(root.scrollTop).toBe(160);
    root.remove();
  });

  it('waits for older server pages before resolving a conversation ordinal', async () => {
    const root = rootWith(
      '<p data-preview-search-content data-id="recent">needle recent</p>',
    );
    root.setAttribute('data-chat-thread-root', '');
    root.setAttribute('data-chat-has-older', 'true');
    root.addEventListener('chat-reveal-search', (event) =>
      event.preventDefault(),
    );
    const finished = vi.fn();
    root.addEventListener('chat-search-finished', finished);
    const onMatch = vi.fn();
    const scroll = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const cancel = scheduleScrollToMatch(() => root, 'needle', 0, { onMatch });
    expect(onMatch).not.toHaveBeenCalled();
    root.innerHTML =
      '<p data-preview-search-content data-id="older">needle older</p><p data-preview-search-content>needle recent</p>';
    root.removeAttribute('data-chat-has-older');
    expect(findRanges(root, 'needle')).toHaveLength(2);
    await vi.waitFor(() => expect(onMatch).toHaveBeenCalledTimes(1));
    expect(
      onMatch.mock.calls[0]?.[0].startContainer.parentElement?.dataset.id,
    ).toBe('older');
    expect(finished).toHaveBeenCalledTimes(1);
    cancel();
    scroll.mockRestore();
    root.remove();
  });

  it('does not silently jump to the first conversation occurrence when the requested one is missing', async () => {
    const root = rootWith('needle');
    root.setAttribute('data-chat-thread-root', '');
    root.addEventListener('chat-reveal-search', (event) =>
      event.preventDefault(),
    );
    const onMatch = vi.fn();
    const onTimeout = vi.fn();
    const finished = vi.fn();
    root.addEventListener('chat-search-finished', finished);
    const cancel = scheduleScrollToMatch(() => root, 'needle', 3, {
      timeoutMs: 10,
      onMatch,
      onTimeout,
    });
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1));
    expect(onMatch).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
    cancel();
    root.remove();
  });

  it('searches marked document content instead of adjacent editor chrome', () => {
    const root = rootWith(`
      <div class="milkdown-slash-menu">Task List</div>
      <div data-preview-search-content>
        Write the report
        <span style="display: none">hidden task</span>
        <span aria-hidden="true">excluded task</span>
      </div>
    `);
    root.setAttribute('data-search-renderer', '');

    expect(findRanges(root, 'task')).toHaveLength(0);
    expect(findRanges(root, 'report')).toHaveLength(1);
    root.remove();
  });

  it('supports navigation within marked document content', () => {
    const root = rootWith(`
      <div>Task List</div>
      <div data-preview-search-content>first task and second task</div>
    `);
    root.setAttribute('data-search-renderer', '');

    expect(findRanges(root, 'task')).toHaveLength(2);
    expect(findNthRange(root, 'task', 1)?.toString()).toBe('task');
    root.remove();
  });

  it.each([
    '<h2>needle label</h2><div data-search-renderer><div>needle menu</div><p data-preview-search-content>needle note</p></div><p>needle text</p>',
    '<p>needle prompt</p><div data-search-renderer><div>needle menu</div><p data-preview-search-content>needle assistant</p></div><blockquote>needle quote</blockquote>',
  ])('preserves sibling Canvas and conversation surfaces: %s', (html) => {
    const root = rootWith(html);
    const ranges = findRanges(root, 'needle');
    expect(ranges).toHaveLength(3);
    expect(
      ranges.map((range) => range.startContainer.parentElement?.textContent),
    ).not.toContain('needle menu');
    expect(
      findNthRange(root, 'needle', 2)?.startContainer.parentElement
        ?.textContent,
    ).toMatch(/needle (text|quote)/);
    root.remove();
  });

  it('reveals cached chat history before choosing a DOM occurrence', async () => {
    const root = rootWith('needle (recent)');
    root.dataset.id = 'recent';
    root.setAttribute('data-chat-thread-root', '');
    root.setAttribute('data-chat-cached-earlier', 'true');
    const reveal = vi.fn((event: Event) => {
      event.preventDefault();
      queueMicrotask(() => {
        root.textContent = 'needle (older), needle (recent)';
        root.dataset.id = 'older';
        root.removeAttribute('data-chat-cached-earlier');
      });
    });
    root.addEventListener('chat-reveal-search', reveal);
    const targets: string[] = [];
    const cancel = scheduleScrollToMatch(() => root, 'needle', 0, {
      onMatch: (range) =>
        targets.push(range.startContainer.parentElement?.dataset.id ?? ''),
    });
    expect(targets).toEqual([]);
    expect(reveal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(root.hasAttribute('data-chat-cached-earlier')).toBe(false),
    );
    expect(findRanges(root, 'needle')).toHaveLength(2);
    await vi.waitFor(() => expect(targets).toEqual(['older']));
    expect(reveal).toHaveBeenCalledTimes(1);
    cancel();
    root.remove();
  });
});
