// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Download } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { Button } from '@/components/Common/Button';
import { MilkdownPreview } from '@/components/Milkdown';
import { usePreviewScrollMemory } from '@/hooks/usePreviewScrollMemory';
import useCanvasStore from '@/store/canvasStore';

import { usePreviewHeaderSlot } from '../PreviewHeaderSlot';

import type { PreviewComponentProps } from '../note/NotePreview';

/**
 * Expanded preview for an Office node (Word / PowerPoint / Excel).
 *
 * Renders the extracted Markdown body that the server-side
 * `OfficeLoader` writes into the node's `.md` sidecar via the
 * preprocess pipeline. The body is read-only — Office documents are
 * preview-only by design, so any further edits should happen in the
 * source application.
 */
export const OfficePreview = ({
  data,
  scrollViewKey,
}: PreviewComponentProps) => {
  const { t } = useTranslation();
  const src = typeof data.src === 'string' ? data.src : '';
  const markdown = typeof data.content === 'string' ? data.content : '';
  const label =
    typeof data.label === 'string' && data.label.trim().length > 0
      ? data.label.trim()
      : t('node.untitledOfficeDocument');
  const canvasId = useCanvasStore((s) => s.canvasId);
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  usePreviewScrollMemory(scrollContainerRef, scrollViewKey);

  const handleDownload = () => {
    if (!src) return;
    const link = document.createElement('a');
    link.href = resolveArtifactUrl(src, canvasId);
    link.download = label;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const headerActions = src ? (
    <Button
      variant="ghost"
      tone="neutral"
      size="sm"
      iconOnly
      title={t('node.downloadOriginalFile')}
      aria-label={t('node.downloadOriginalFile')}
      onClick={handleDownload}
    >
      <Download />
    </Button>
  ) : null;

  return (
    <div className="bg-surface relative flex h-full w-full flex-col overflow-hidden">
      {headerSlotEl && headerActions
        ? createPortal(headerActions, headerSlotEl)
        : null}

      <div ref={scrollContainerRef} className="flex-1 overflow-auto px-6 py-4">
        {markdown.trim().length === 0 ? (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            {t('node.noExtractedContentYet')}
          </div>
        ) : (
          <MilkdownPreview markdown={markdown} />
        )}
      </div>
    </div>
  );
};
