// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Typography primitives.
 *
 * Every heading auto-generates an `id` from its text so the
 * right-side table-of-contents links resolve via plain `#anchor`
 * navigation — no extra wiring required at the call site.
 */

import { cn } from './cn';

import type { ReactNode } from 'react';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function headingId(children: ReactNode): string | undefined {
  return typeof children === 'string' ? slugify(children) : undefined;
}

export function H1({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      id={headingId(children)}
      className={cn(
        'text-3xl font-semibold tracking-tight text-gray-900',
        className,
      )}
    >
      {children}
    </h1>
  );
}

export function H2({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={headingId(children)}
      className={cn(
        'mt-10 scroll-mt-8 text-xl font-semibold text-gray-900',
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function H3({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h3
      id={headingId(children)}
      className={cn(
        'mt-6 scroll-mt-8 text-base font-semibold text-gray-900',
        className,
      )}
    >
      {children}
    </h3>
  );
}

export function P({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('text-[15px] leading-relaxed text-gray-700', className)}>
      {children}
    </p>
  );
}
