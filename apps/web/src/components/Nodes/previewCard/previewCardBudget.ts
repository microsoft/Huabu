// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Line budget for a PDF card's text area.
 *
 * The area below (or beside) the cover is a fixed height. It is filled in
 * priority order — title, tags, text properties, note excerpt — in three
 * passes, so space is never left empty while a higher block is truncated:
 *
 *   1. Each block claims its guaranteed share (title 2 lines, tags 1 row,
 *      text properties 2 lines in total, one per property before any gets
 *      two), highest priority first. When even that does not fit, the lowest
 *      blocks give way first.
 *   2. The excerpt takes what remains, as far as it needs.
 *   3. Anything still unused goes back to truncated blocks: title, then
 *      tags, then text properties in order.
 */

export const CARD_TITLE_LINES = 2;
export const CARD_TAG_ROWS = 1;
export const CARD_TEXT_LINES = 2;
/**
 * Least share of the card's inner height given to a vertical PDF cover. The
 * text area is budgeted against the rest; whatever it then leaves unused goes
 * back to the cover, so a sparse card shows a larger page, not a blank band.
 */
export const CARD_COVER_SHARE = 0.45;
/**
 * Tags laid out for measurement. A card shows a few rows at most, so tags
 * past this never appear as chips; they are counted in the "+N" marker
 * without being rendered or measured.
 */
export const CARD_MEASURED_TAGS = 48;

export interface CardBudgetInput {
  /** Height available to all blocks, in px. */
  available: number;
  titleLine: number;
  /** Height of one line of a text property or the excerpt. */
  textLine: number;
  tagRow: number;
  tagRowGap: number;
  /** Space above a block, charged once when it shows at all. */
  tagGap: number;
  /** Above the first text property. */
  textGap: number;
  /** Between consecutive text properties, which read as one group. */
  textInnerGap: number;
  summaryGap: number;
  /** Lines or rows each block needs to show in full. */
  titleNeed: number;
  tagRowsNeed: number;
  textNeeds: readonly number[];
  summaryNeed: number;
}

export interface CardBudget {
  titleLines: number;
  tagRows: number;
  textLines: number[];
  summaryLines: number;
}

interface Block {
  /** Height of the nth unit (1-based), including any gap it introduces. */
  cost: (n: number) => number;
  need: number;
  count: number;
  /** Set on text properties: called when the block gets its first line. */
  onShown?: () => void;
}

export function allocateCardLines(input: CardBudgetInput): CardBudget {
  const titled = input.titleNeed > 0;
  const title: Block = {
    cost: () => input.titleLine,
    need: input.titleNeed,
    // A titled card always names its document, whatever else is dropped.
    count: titled ? 1 : 0,
  };
  const tags: Block = {
    cost: (n) => input.tagRow + (n === 1 ? input.tagGap : input.tagRowGap),
    need: input.tagRowsNeed,
    count: 0,
  };
  // The first property to be shown opens the group and pays the group gap,
  // whichever one that turns out to be; only properties after it join at the
  // inner gap. (A later one must not slip in cheaply past an earlier one that
  // could not afford to open the group.)
  // Lines are granted in property order and every property costs the same
  // to open, so once one is shown every later one follows an open group.
  let groupOpen = false;
  const texts: Block[] = input.textNeeds.map((need) => ({
    cost: (n) =>
      input.textLine +
      (n > 1 ? 0 : groupOpen ? input.textInnerGap : input.textGap),
    need,
    count: 0,
    onShown: () => {
      groupOpen = true;
    },
  }));
  const summary: Block = {
    cost: (n) => input.textLine + (n === 1 ? input.summaryGap : 0),
    need: input.summaryNeed,
    count: 0,
  };

  let left = input.available - (titled ? title.cost(1) : 0);
  const grow = (block: Block, limit: number) => {
    const target = Math.min(block.need, limit);
    while (block.count < target && block.cost(block.count + 1) <= left) {
      left -= block.cost(block.count + 1);
      block.count += 1;
      if (block.count === 1) block.onShown?.();
    }
  };

  grow(title, CARD_TITLE_LINES);
  grow(tags, CARD_TAG_ROWS);
  // One line each before anyone gets a second, so a long first property
  // does not hide the next one.
  let textShare = CARD_TEXT_LINES;
  for (const limit of [1, CARD_TEXT_LINES]) {
    for (const text of texts) {
      const before = text.count;
      grow(text, Math.min(limit, before + textShare));
      textShare -= text.count - before;
    }
  }
  grow(summary, Infinity);
  for (const block of [title, tags, ...texts]) grow(block, Infinity);

  return {
    titleLines: title.count,
    tagRows: tags.count,
    textLines: texts.map((text) => text.count),
    summaryLines: summary.count,
  };
}

/** Height the allocated blocks occupy, gaps included. */
export function cardTextHeight(
  input: Pick<
    CardBudgetInput,
    | 'titleLine'
    | 'textLine'
    | 'tagRow'
    | 'tagRowGap'
    | 'tagGap'
    | 'textGap'
    | 'textInnerGap'
    | 'summaryGap'
  >,
  budget: CardBudget,
): number {
  const lines = (count: number, gap: number) =>
    count > 0 ? gap + count * input.textLine : 0;
  let textShown = false;
  let texts = 0;
  for (const count of budget.textLines) {
    texts += lines(count, textShown ? input.textInnerGap : input.textGap);
    textShown ||= count > 0;
  }
  return (
    budget.titleLines * input.titleLine +
    (budget.tagRows > 0
      ? input.tagGap +
        budget.tagRows * input.tagRow +
        (budget.tagRows - 1) * input.tagRowGap
      : 0) +
    texts +
    lines(budget.summaryLines, input.summaryGap)
  );
}

/** Rows needed to show every tag, wrapping greedily. */
export function tagRowsNeeded(
  widths: readonly number[],
  rowWidth: number,
  gap: number,
): number {
  if (widths.length === 0) return 0;
  if (rowWidth <= 0) return 1;
  let rows = 1;
  let used = 0;
  for (const raw of widths) {
    const width = Math.min(raw, rowWidth);
    const next = used === 0 ? width : used + gap + width;
    if (next > rowWidth && used > 0) {
      rows += 1;
      used = width;
    } else {
      used = next;
    }
  }
  return rows;
}

/**
 * How many leading tags fit in `rows` rows when the rest collapse into one
 * trailing "+N" marker of `moreWidth`. One pass: property lists are unbounded
 * and this runs during card layout. `moreFollow` says further tags exist
 * beyond `widths`, so the marker is needed even when all of these fit.
 */
export function visibleTagCount(
  widths: readonly number[],
  rowWidth: number,
  gap: number,
  rows: number,
  moreWidth: number,
  moreFollow = false,
): number {
  if (rows <= 0) return 0;
  // Unmeasured (not laid out yet): show everything rather than nothing.
  if (rowWidth <= 0) return widths.length;
  // Where an item of `width` lands after `used` px on `row`.
  const place = (row: number, used: number, width: number) => {
    const next = used === 0 ? width : used + gap + width;
    return next > rowWidth && used > 0
      ? { row: row + 1, used: width }
      : { row, used: next };
  };
  const marker = Math.min(moreWidth, rowWidth);
  let row = 1;
  let used = 0;
  let fitting = 0;
  for (let index = 0; index < widths.length; index += 1) {
    ({ row, used } = place(row, used, Math.min(widths[index], rowWidth)));
    if (row > rows) break;
    const count = index + 1;
    // A prefix counts only if the marker for the rest still fits after it.
    if (
      (count === widths.length && !moreFollow) ||
      place(row, used, marker).row <= rows
    )
      fitting = count;
  }
  return fitting;
}
