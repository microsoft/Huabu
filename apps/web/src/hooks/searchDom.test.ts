// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { findNthRange, findRanges, scheduleScrollToMatch } from './searchDom';

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.style.display = 'block';
  root.style.visibility = 'visible';
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('preview DOM search boundaries', () => {
  it('searches marked document content instead of adjacent editor chrome', () => {
    const root = rootWith(`
      <div class="milkdown-slash-menu">Task List</div>
      <div data-preview-search-content>
        Write the report
        <span style="display: none">hidden task</span>
        <span aria-hidden="true">excluded task</span>
      </div>
    `);

    expect(findRanges(root, 'task')).toHaveLength(0);
    expect(findRanges(root, 'report')).toHaveLength(1);
    root.remove();
  });

  it('supports navigation within marked document content', () => {
    const root = rootWith(`
      <div>Task List</div>
      <div data-preview-search-content>first task and second task</div>
    `);

    expect(findRanges(root, 'task')).toHaveLength(2);
    expect(findNthRange(root, 'task', 1)?.toString()).toBe('task');
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
    const scroll = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(function (this: HTMLElement) {
        targets.push(this.dataset.id ?? '');
      });
    const cancel = scheduleScrollToMatch(() => root, 'needle', 0);
    expect(targets).toEqual([]);
    expect(reveal).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(root.hasAttribute('data-chat-cached-earlier')).toBe(false),
    );
    expect(findRanges(root, 'needle')).toHaveLength(2);
    await vi.waitFor(() => expect(targets).toEqual(['older']));
    expect(reveal).toHaveBeenCalledTimes(1);
    cancel();
    scroll.mockRestore();
    root.remove();
  });
});
