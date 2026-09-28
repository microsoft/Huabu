// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  NOTE_CONTENT_HOST_CLASS,
  NOTE_CONTENT_HOST_STYLE,
} from './noteContentHost';

import type { ReactNode, Ref, UIEventHandler } from 'react';

import './noteScrollbar.css';

/** Store-free geometry shared by canvas Notes and read-only specimens. */
export function NoteContentViewport({
  scrollingEnabled,
  viewportRef,
  contentHostRef,
  onScroll,
  children,
}: {
  scrollingEnabled: boolean;
  viewportRef: Ref<HTMLDivElement>;
  contentHostRef: Ref<HTMLDivElement>;
  onScroll: UIEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div className="h-full w-full overflow-hidden">
      <div className="huabu-note-scroll-frame h-full w-full">
        <div
          ref={viewportRef}
          data-note-content-viewport=""
          data-note-scroll-enabled={scrollingEnabled}
          className="huabu-note-scroll-viewport h-full"
          style={{
            overflowY: scrollingEnabled ? 'auto' : 'hidden',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
          }}
          onScroll={onScroll}
        >
          <div
            ref={contentHostRef}
            // Intrinsic document geometry; compare against the separate viewport.
            data-note-content-host=""
            className={`${NOTE_CONTENT_HOST_CLASS} min-h-full`}
            style={NOTE_CONTENT_HOST_STYLE}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
