// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { NotePreview } from './NotePreview';

const editorProps = vi.hoisted(() => ({
  current: null as {
    editable: boolean;
    onChange: (markdown: string) => void;
    onExternalUpdate: (update: {
      oldKeys: string[];
      newKeys: string[];
    }) => void;
  } | null,
}));

// The editor library is outside this component's permission boundary. Keep
// NotePreview's real callbacks, state, and read-only propagation under test.
vi.mock('@/components/Milkdown', () => ({
  MilkdownEditor: (props: NonNullable<typeof editorProps.current>) => {
    editorProps.current = props;
    return <div data-editor-editable={props.editable} />;
  },
}));
vi.mock('@/components/CodeMirror/RawMarkdownEditor', () => ({
  default: ({ readOnly, value }: { readOnly: boolean; value: string }) => (
    <textarea readOnly={readOnly} value={value} onChange={() => undefined} />
  ),
}));
vi.mock('./NoteCommentActions', () => ({ NoteCommentActions: () => null }));
vi.mock('@/components/Milkdown/MilkdownFloatingToolbar', () => ({
  MilkdownFloatingToolbar: () => null,
}));
vi.mock('./ProvenanceOverlay', () => ({ ProvenanceOverlay: () => null }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  editorProps.current = null;
});

it('a viewer receives a non-editable note and cannot emit content or provenance updates', () => {
  const onDataChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <NotePreview
        data={{ content: 'Readable' }}
        readOnly
        onDataChange={onDataChange}
      />,
    ),
  );
  expect(editorProps.current?.editable).toBe(false);
  act(() => editorProps.current?.onChange('Forbidden edit'));
  act(() =>
    editorProps.current?.onExternalUpdate({
      oldKeys: ['old'],
      newKeys: ['new'],
    }),
  );
  expect(onDataChange).not.toHaveBeenCalled();
});

it('retained editor callbacks cannot emit after write permission is removed', () => {
  const onDataChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <NotePreview
        data={{ content: 'Unsaved draft' }}
        onDataChange={onDataChange}
      />,
    ),
  );
  const retained = editorProps.current;
  if (!retained) throw new Error('Expected mounted note editor');
  expect(retained.editable).toBe(true);
  act(() =>
    root?.render(
      <NotePreview
        data={{ content: 'Unsaved draft' }}
        readOnly
        onDataChange={onDataChange}
      />,
    ),
  );
  expect(editorProps.current?.editable).toBe(false);
  act(() => retained.onChange('Queued edit'));
  act(() => retained.onExternalUpdate({ oldKeys: ['old'], newKeys: ['new'] }));
  expect(onDataChange).not.toHaveBeenCalled();
});
