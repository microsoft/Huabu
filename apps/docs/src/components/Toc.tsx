// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Right-side table of contents for a section page.
 *
 * The page passes a list of `{ id, label, level }` entries that map
 * to heading anchors emitted by the typography components in
 * `Heading.tsx`. Levels 2 and 3 are indented to mirror the document
 * hierarchy without becoming visually noisy.
 */

import { cn } from './cn';

export type TocEntry = {
  /** The `id` of the heading to jump to. */
  id: string;
  /** Sidebar label — usually the heading text. */
  label: string;
  /** 2 for `<H2>`, 3 for `<H3>`. Defaults to 2. */
  level?: 2 | 3;
};

export function Toc({ entries }: { entries: TocEntry[] }) {
  if (!entries.length) return null;

  return (
    <nav aria-label="On this page" className="text-[13px]">
      <div className="mb-3 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
        On this page
      </div>
      <ul className="space-y-1.5 border-l border-gray-200">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              className={cn(
                '-ml-px block border-l border-transparent py-0.5 pl-3 text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-900',
                entry.level === 3 && 'pl-6',
              )}
            >
              {entry.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
