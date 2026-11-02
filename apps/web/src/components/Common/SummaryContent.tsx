// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';

import { markdownSummaryBlocks } from '@huabu/shared/canvas-engine';

/** Display-only summary markup; the caller owns typography and height limits. */
export function SummaryContent({
  summary,
  compact = false,
}: {
  summary: string;
  compact?: boolean;
}) {
  const blocks = useMemo(() => markdownSummaryBlocks(summary), [summary]);
  if (compact)
    return blocks
      .flatMap((block) => (block.type === 'list' ? block.items : [block.text]))
      .join(' ');
  return blocks.map((block, index) => {
    if (block.type === 'paragraph')
      return (
        <p key={index} className="m-0">
          {block.text}
        </p>
      );
    const List = block.ordered ? 'ol' : 'ul';
    return (
      <List
        key={index}
        start={block.ordered ? block.start : undefined}
        className={`m-0 ps-[1.25em] ${block.ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {block.items.map((text, itemIndex) => (
          <li key={itemIndex}>{text}</li>
        ))}
      </List>
    );
  });
}
