// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ToolCallCard } from './ToolCallCard';

import type { GenericToolPart } from '@huabu/shared';

// The link's own suite covers opening; here only which paths are listed.
vi.mock('./FilePathLink', () => ({
  FilePathLink: ({ path }: { path: string }) => (
    <span data-file-path="">{path}</span>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('names an edited file once when its location and diff share a path', () => {
  const part = {
    kind: 'tool',
    variant: 'generic',
    toolCallId: 'edit-1',
    title: 'Write /repo/a.ts',
    toolKind: 'edit',
    status: 'completed',
    locations: [{ path: '/repo/a.ts' }],
    content: [
      { type: 'diff', path: '/repo/a.ts', oldText: '', newText: 'a' },
      { type: 'diff', path: '/repo/b.ts', oldText: '', newText: 'b' },
    ],
  } as GenericToolPart;
  act(() => root.render(<ToolCallCard part={part} />));
  act(() => container.querySelector('button')?.click());

  expect(
    [...container.querySelectorAll('[data-file-path]')].map(
      (node) => node.textContent,
    ),
  ).toEqual(['/repo/a.ts', '/repo/b.ts']);
});
