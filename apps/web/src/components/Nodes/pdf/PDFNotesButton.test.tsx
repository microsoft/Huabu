// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { openPdfNotes } from '@/store/previewWorkspace/actions';

import { PDFNotesButton } from './PDFNotesButton';

vi.mock('@/store/previewWorkspace/actions', () => ({ openPdfNotes: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['canvas', 'preview'] as const)(
  'opens notes directly from the %s toolbar without a link picker',
  (surface) => {
    vi.clearAllMocks();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<PDFNotesButton id="pdf" surface={surface} />));
      expect(container.querySelector('button')?.textContent).toBe(
        surface === 'preview' ? 'node.addPdfNotes' : '',
      );
      act(() => container.querySelector('button')?.click());
      expect(openPdfNotes).toHaveBeenCalledExactlyOnceWith('pdf');
      expect(document.querySelector('[role="dialog"], input')).toBeNull();
      act(() =>
        root.render(
          <PDFNotesButton
            id="pdf"
            surface={surface}
            noteContent="Existing notes"
          />,
        ),
      );
      expect(container.querySelector('button')?.textContent).toBe(
        surface === 'preview' ? 'node.openPdfNotes' : '',
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
