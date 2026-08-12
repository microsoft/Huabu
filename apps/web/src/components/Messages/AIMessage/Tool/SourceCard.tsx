// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { ArrowUpRight } from 'lucide-react';
import { useRef } from 'react';

import { useChatSession } from '../../../../hooks/useChatSession';
import { setDragPayload } from '../../../../utils/io/dragDrop';
import { DragToCanvasHandleButton } from '../../../Common/DragToCanvasHandleButton';

export type Source = {
  title: string;
  url: string;
  favicon?: string;
};

const getHostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

export const SourceCard = ({ source }: { source: Source }) => {
  const title = (source.title ?? '').trim() || source.url;
  const hostname = getHostname(source.url);
  const cardRef = useRef<HTMLAnchorElement | null>(null);
  const { threadId } = useChatSession();

  return (
    <div
      className="group relative px-4"
      data-source-url={source.url}
      data-source-title={title}
    >
      <DragToCanvasHandleButton
        className={clsx(
          'absolute top-1 left-0',
          'opacity-0 transition-opacity',
          'group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100',
        )}
        onDragStart={(e) => {
          e.stopPropagation();

          setDragPayload(
            e,
            {
              kind: 'web',
              origin: { type: 'user-from-chat', threadId },
              data: {
                src: source.url,
              },
            },
            {
              dragImageElement: cardRef.current,
            },
          );
        }}
      />
      <a
        ref={cardRef}
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className={clsx(
          'border-edge-default bg-surface block rounded-lg border px-3 py-2',
          'hover:bg-bg-default ml-1 transition-colors',
        )}
      >
        <div className="flex items-start gap-2">
          {source.favicon ? (
            <img
              src={source.favicon}
              alt=""
              className="mt-0.5 h-4 w-4 flex-none rounded-sm"
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="text-fg-muted flex min-w-0 items-center gap-2 text-xs font-medium">
              <span className="truncate">{title}</span>
              <ArrowUpRight
                className="text-fg-muted flex-none"
                size={14}
                strokeWidth={2}
              />
            </div>
            {hostname ? (
              <div className="text-fg-muted mt-0.5 truncate text-xs">
                {hostname}
              </div>
            ) : null}
          </div>
        </div>
      </a>
    </div>
  );
};
