// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { findNthRange, findRanges } from './searchDom';

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
});
