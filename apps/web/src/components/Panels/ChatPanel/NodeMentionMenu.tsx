// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  MENU_ITEM_CLASS,
  MENU_SECTION_LABEL_CLASS,
  MENU_SURFACE_CLASS,
} from '@/components/Common/menuStyles';
import { getNodeIcon } from '@/config/nodeIcons';

import type { useNodeMentionTypeahead } from './useNodeMentionTypeahead';

export function NodeMentionMenu({
  mention,
}: {
  mention: ReturnType<typeof useNodeMentionTypeahead>;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  useEffect(() => {
    if (hovering.current) {
      hovering.current = false;
      return;
    }
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [mention.activeIndex, mention.query]);

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
      >
        {mention.matches.map(({ node, label }, index) => {
          const Icon = getNodeIcon(node.type, node.data);
          const typeKey = node.type === 'office' ? 'office.generic' : node.type;
          return (
            <Button
              key={node.id}
              id={`${mention.menuId}-${index}`}
              variant="ghost"
              role="option"
              tabIndex={-1}
              aria-selected={index === mention.activeIndex}
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
      {mention.matches.length === 0 ? (
        <div role="status" className="text-fg-muted px-2 py-2 text-xs">
          {t('chat.noMatchingNodes')}
        </div>
      ) : null}
    </div>
  );
}
