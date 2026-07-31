// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Styled link.
 *
 * - Internal links (starting with `/`) use react-router's `Link` so
 *   they don't trigger a full page reload.
 * - Same-page anchors (starting with `#`) use a regular anchor.
 * - External links open in a new tab with `rel="noopener"`.
 */

import { Link as RouterLink } from 'react-router';

import { cn } from './cn';

import type { AnchorHTMLAttributes, ReactNode } from 'react';

type DocLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children'>;

export function DocLink({ href, children, className, ...rest }: DocLinkProps) {
  const isInternal = href.startsWith('/') && !href.startsWith('//');
  const isSamePageAnchor = href.startsWith('#');
  const classes = cn(
    'font-medium text-gray-900 underline decoration-gray-400 underline-offset-2 transition-colors hover:decoration-gray-900',
    className,
  );

  if (isInternal) {
    return (
      <RouterLink to={href} className={classes}>
        {children}
      </RouterLink>
    );
  }

  if (isSamePageAnchor) {
    return (
      <a href={href} className={classes} {...rest}>
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classes}
      {...rest}
    >
      {children}
    </a>
  );
}
