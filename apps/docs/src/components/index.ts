// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Barrel export for the docs component library.
 *
 * Every section page imports from `'../components'` (or
 * `'../../components'` for nested folders) instead of reaching into
 * individual files, so future renames don't ripple across the docs.
 */

export { Callout } from './Callout';
export { CardGrid, NavCard } from './Card';
export { Code, CodeBlock, Kbd } from './Code';
export { H1, H2, H3, P, slugify } from './Heading';
export { DocImage } from './Image';
export { DocLink } from './Link';
export { PageLayout } from './PageLayout';
export { Shortcut } from './Shortcut';
export { Table } from './Table';
export { Toc, type TocEntry } from './Toc';
export { cn } from './cn';
