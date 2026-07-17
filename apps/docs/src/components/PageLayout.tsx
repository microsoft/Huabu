// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-section page chrome.
 *
 * Handles the three pieces every page needs:
 * - The page title block (with optional description).
 * - The main scrollable content column.
 * - An optional right-side table of contents that sticks while
 *   scrolling.
 */

import { useEffect, type ReactNode } from 'react';

import { H1, P } from './Heading';
import { Toc, type TocEntry } from './Toc';

type PageLayoutProps = {
  title: string;
  description?: ReactNode;
  /** Right-side anchor list. Omit to render full-width. */
  toc?: TocEntry[];
  children: ReactNode;
};

export function PageLayout({
  title,
  description,
  toc,
  children,
}: PageLayoutProps) {
  useEffect(() => {
    const rawHash = window.location.hash.slice(1);
    if (!rawHash) return;

    let id = rawHash;
    try {
      id = decodeURIComponent(rawHash);
    } catch {
      // Keep the raw hash if it isn't valid percent-encoding.
    }

    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    // Horizontal padding comes from `DocsLayout`'s gutter variables
    // so every page lines up identically against the sidebar and
    // viewport edge. The gap between the content column and the
    // sticky TOC is fixed at 4vw per the docs spacing spec.
    <div className="flex gap-x-[4vw] py-12">
      <article data-pagefind-body className="min-w-0 flex-1 space-y-6">
        <header className="space-y-3">
          <H1>{title}</H1>
          {description && <P className="text-base">{description}</P>}
        </header>
        <div className="space-y-5">{children}</div>
      </article>

      {toc && toc.length > 0 && (
        <aside className="sticky top-12 hidden h-fit w-56 shrink-0 self-start rounded-xl bg-gray-50 p-4 lg:block">
          <Toc entries={toc} />
        </aside>
      )}
    </div>
  );
}
