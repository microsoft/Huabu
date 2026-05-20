/**
 * Read-only Milkdown surface, optionally isolated in a Shadow DOM.
 *
 * Phase 1b uses this anywhere we currently use `BlockNoteCard` (chat
 * messages, AI previews). The Shadow DOM isolation matches the
 * BlockNote pattern: it keeps Milkdown's CSS from leaking into the
 * surrounding page (and vice-versa) without giving up document-level
 * styles, thanks to `applySharedStyles`.
 */

import { useEffect, useRef } from 'react';

import { applySharedStyles } from '@/utils/shadowStyleCache';

import { createMilkdown, type MilkdownInstance } from './createMilkdown';
import { markdownEquals, normalizeMarkdown } from './markdownUtils';

import type { MilkdownBlockDragEvent } from './types';

export interface MilkdownPreviewProps {
  markdown: string;
  /** Render inside a Shadow DOM. Default `true` for style isolation. */
  isolate?: boolean;
  className?: string;
  /** Reserved for Phase 5; not wired in Phase 1b. */
  onBlockDragStart?: (event: MilkdownBlockDragEvent) => void;
}

export function MilkdownPreview(props: MilkdownPreviewProps): JSX.Element {
  const { markdown, isolate = true, className } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<MilkdownInstance | null>(null);
  const lastSyncedRef = useRef<string>(normalizeMarkdown(markdown));
  const pendingMarkdownRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // Resolve the mount node. With isolation we attach a fresh Shadow
    // DOM and let Milkdown live inside its own document-style scope.
    let mountRoot: HTMLElement;
    let createdShadow: ShadowRoot | null = null;
    if (isolate) {
      // attachShadow throws if a shadow root already exists. In React
      // StrictMode the first effect run may have created one already
      // (the cleanup keeps the host element). Guard with `shadowRoot`.
      const existing = container.shadowRoot;
      const shadow = existing ?? container.attachShadow({ mode: 'open' });
      if (!existing) createdShadow = shadow;
      applySharedStyles(shadow);
      // Clear any leftover children (e.g. from the previous mount).
      while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
      const inner = document.createElement('div');
      shadow.appendChild(inner);
      mountRoot = inner;
    } else {
      mountRoot = container;
    }

    void (async () => {
      const instance = await createMilkdown({
        root: mountRoot,
        initialMarkdown: lastSyncedRef.current,
        editable: false,
      });

      if (cancelled) {
        await instance.destroy();
        return;
      }

      instanceRef.current = instance;

      const pending = pendingMarkdownRef.current;
      pendingMarkdownRef.current = null;
      if (pending !== null && pending !== lastSyncedRef.current) {
        lastSyncedRef.current = pending;
        instance.setMarkdown(pending);
      }
    })();

    return () => {
      cancelled = true;
      const instance = instanceRef.current;
      instanceRef.current = null;
      if (instance) void instance.destroy();
      // Shadow roots cannot be detached from their host. We just clear
      // children so a subsequent mount starts fresh.
      if (createdShadow) {
        while (createdShadow.firstChild) {
          createdShadow.removeChild(createdShadow.firstChild);
        }
      }
    };
    // Re-mount when isolation toggles (rare, expected).
  }, [isolate]);

  useEffect(() => {
    if (markdownEquals(markdown, lastSyncedRef.current)) return;
    const next = normalizeMarkdown(markdown);
    const instance = instanceRef.current;
    if (!instance) {
      pendingMarkdownRef.current = next;
      return;
    }
    lastSyncedRef.current = next;
    instance.setMarkdown(next);
  }, [markdown]);

  return <div ref={containerRef} className={className} />;
}
