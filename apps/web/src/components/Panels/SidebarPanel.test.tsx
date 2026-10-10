// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { SidebarPanel } from './SidebarPanel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render({
  compactHeader = false,
  hideTitle = false,
  tools = false,
  isCollapsed = false,
}: {
  compactHeader?: boolean;
  hideTitle?: boolean;
  tools?: boolean;
  isCollapsed?: boolean;
} = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SidebarPanel
        title="Chat"
        iconCollapsed={null}
        iconExpanded={null}
        compactHeader={compactHeader}
        hideTitle={hideTitle}
        tools={tools ? <span data-testid="tools">Tools</span> : undefined}
        isCollapsed={isCollapsed}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SidebarPanel', () => {
  it.each([false, true])(
    'uses medium 14px section titles when collapsed=%s',
    (isCollapsed) => {
      render({ isCollapsed });
      const title = container?.querySelector(
        isCollapsed ? 'span.text-sm.font-medium' : 'span[title="Chat"]',
      );
      const typography = isCollapsed ? title : title?.parentElement;
      expect(title?.textContent).toBe('Chat');
      expect(typography?.classList.contains('text-sm')).toBe(true);
      expect(typography?.classList.contains('font-medium')).toBe(true);
    },
  );

  it('keeps the default header height', () => {
    render();
    expect(container?.querySelector('.h-12')).not.toBeNull();
  });

  it('uses a compact header when embedded', () => {
    render({ compactHeader: true });
    const header = container?.querySelector('.h-9');
    expect(header).not.toBeNull();
    expect(header?.classList.contains('border-b')).toBe(false);
  });

  it('does not append a divider when tools have no collapse control', () => {
    render({ compactHeader: true, tools: true });
    expect(container?.querySelector('[data-testid="tools"]')).not.toBeNull();
    expect(container?.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('visually hides a redundant title without removing it', () => {
    render({ hideTitle: true });
    expect(container?.querySelector('.sr-only')?.textContent).toBe('Chat');
  });
});
