// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  MENU_ITEM_CLASS,
  MENU_SECTION_LABEL_CLASS,
  MENU_SURFACE_CLASS,
} from '@/components/Common/menuStyles';
import { getNodeIcon } from '@/config/nodeIcons';

import type { useNodeMentionTypeahead } from './useNodeMentionTypeahead';

const ROW_HEIGHT = 28;
const VISIBLE_ROWS = 8;
const OVERSCAN_ROWS = 3;

export function NodeMentionMenu({
  mention,
}: {
  mention: ReturnType<typeof useNodeMentionTypeahead>;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    if (hovering.current) {
      hovering.current = false;
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const top = mention.activeIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const height = VISIBLE_ROWS * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + height) list.scrollTop = bottom - height;
    setScrollTop(list.scrollTop);
  }, [mention.activeIndex, mention.query]);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const end = Math.min(
    mention.matches.length,
    Math.ceil(scrollTop / ROW_HEIGHT) + VISIBLE_ROWS + OVERSCAN_ROWS,
  );
  const indices = Array.from(
    { length: Math.max(0, end - first) },
    (_, i) => first + i,
  );
  // Keep aria-activedescendant mounted when the pointer scrolls away from it.
  if (mention.matches.length && !indices.includes(mention.activeIndex)) {
    indices.push(mention.activeIndex);
    indices.sort((a, b) => a - b);
  }

  return (
    <div
      data-node-mention-menu
      className={`${MENU_SURFACE_CLASS} border-edge-default bg-surface absolute bottom-full left-0 z-50 mb-2 w-full max-w-sm border shadow-lg`}
    >
      <div className={`${MENU_SECTION_LABEL_CLASS} truncate`}>
        {mention.query
          ? t('chat.nodesMatching', { query: mention.query })
          : t('chat.mentionNodes')}
      </div>
      <div
        ref={listRef}
        id={mention.menuId}
        role="listbox"
        aria-label={t('chat.mentionNodes')}
        className="max-h-56 overflow-y-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          role="presentation"
          className="relative"
          style={{ height: mention.matches.length * ROW_HEIGHT }}
        >
          {indices.map((index) => {
            const { node, label } = mention.matches[index];
            const Icon = getNodeIcon(node.type, node.data);
            const typeKey =
              node.type === 'office' ? 'office.generic' : node.type;
            return (
              <Button
                key={node.id}
                id={`${mention.menuId}-${index}`}
                variant="ghost"
                role="option"
                tabIndex={-1}
                aria-selected={index === mention.activeIndex}
                aria-posinset={index + 1}
                aria-setsize={mention.matches.length}
                style={{
                  position: 'absolute',
                  top: index * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  width: '100%',
                }}
                className={`${MENU_ITEM_CLASS} ${index === mention.activeIndex ? 'bg-hover' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  hovering.current = index !== mention.activeIndex;
                  mention.highlight(index);
                }}
                onClick={() => mention.accept(index)}
              >
                <Icon aria-hidden />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="text-fg-subtle shrink-0 text-xs">
                  {t(`layers.filterLabels.${typeKey}`, {
                    defaultValue: node.type ?? '',
                  })}
                </span>
              </Button>
            );
          })}
        </div>
      </div>
      {mention.matches.length === 0 ? (
        <div role="status" className="text-fg-muted px-2 py-2 text-xs">
          {t('chat.noMatchingNodes')}
        </div>
      ) : null}
    </div>
  );
}
