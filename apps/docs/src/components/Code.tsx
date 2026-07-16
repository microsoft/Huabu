// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Inline `<Code>` for short identifiers, and block `<CodeBlock>` for
 * snippets. Both are stylistic only — no syntax highlighting — which
 * keeps the docs module dependency-free.
 */

import { cn } from './cn';

import type { ReactNode } from 'react';

export function Code({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code
      className={cn(
        'rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-800',
        className,
      )}
    >
      {children}
    </code>
  );
}

export function CodeBlock({
  children,
  language,
  className,
}: {
  children: ReactNode;
  language?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg border border-gray-200 bg-gray-50',
        className,
      )}
    >
      {language && (
        <div className="border-b border-gray-200 bg-white px-4 py-1.5 font-mono text-[11px] tracking-wide text-gray-500 uppercase">
          {language}
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-gray-800">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-gray-300 bg-white px-1.5 font-mono text-[11px] text-gray-700 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
      {children}
    </kbd>
  );
}
