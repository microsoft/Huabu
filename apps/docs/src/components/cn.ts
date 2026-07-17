// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Local class-name combinator for the docs module.
 *
 * The docs folder is intentionally decoupled from the rest of the
 * web app so it can be lifted out into a standalone site later. We
 * keep our own `cn` here instead of reaching into
 * `apps/web/src/components/Common/cn`.
 */
export function cn(...args: (string | false | null | undefined)[]): string {
  return args.filter(Boolean).join(' ');
}
