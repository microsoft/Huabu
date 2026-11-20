// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { $remark } from '@milkdown/utils';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly';

/**
 * Relax CommonMark's delimiter-run rules next to CJK text.
 *
 * CommonMark refuses to close emphasis when the closing delimiter follows
 * punctuation and precedes a letter, a rule designed around space-separated
 * words. CJK prose has no such spaces, so `**一句话。**后文` parses as literal
 * asterisks, and the serializer then persists them as `\*\*`. These plugins
 * only change how `*`, `_` and `~~` runs adjacent to CJK characters are
 * recognised; the stored markdown stays byte-identical to what was written.
 *
 * Only the parse-side entry points are used. Milkdown serializes strong and
 * emphasis through its own handlers, and the plugins' serializer extension
 * replaces `containerPhrasing` in a way that throws on Milkdown's table cells.
 */
export const cjkFriendlyEmphasisPlugins = [
  $remark('huabuCjkFriendlyEmphasis', () => remarkCjkFriendly),
  $remark(
    'huabuCjkFriendlyStrikethrough',
    () => remarkCjkFriendlyGfmStrikethrough,
  ),
].flat();
