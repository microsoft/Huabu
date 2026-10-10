// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getFilterKeyLabelKey, getFilterKeyMeta } from './layerFilterKey';
import { Button } from '../../Common/Button';
import { DropdownMenu, DropdownMenuItem } from '../../Common/DropdownMenu';

import type { LayerFilterKey } from './layerFilterKey';

const FILTER_BUTTON_WIDTH_PX = 24;
const FILTER_BUTTON_GAP_PX = 2;

interface LayerFilterBarProps {
  /**
   * Filter keys currently present on the canvas, in canonical order.
   * Office is split per format (Word / Excel / PowerPoint) so the chip
   * row mirrors what the user sees in the list rows below — see
   * {@link LayerFilterKey} for the encoding.
   */
  availableKeys: LayerFilterKey[];
  /**
   * Whitelist of filter keys the user has clicked. An empty set means
   * "no explicit type constraint"; the ordinary hierarchy applies its
   * default visibility policy, while Canvas search remains unrestricted.
   * Otherwise only nodes whose key is in this set survive the filter.
   */
  selectedKeys: Set<LayerFilterKey>;
  onToggleKey: (key: LayerFilterKey) => void;
  /**
   * Whether the canvas currently contains at least one frame / group.
   * Controls visibility of the collapse-all toggle (no frames → no
   * point showing the button).
   */
  hasAnyFrame: boolean;
  /**
   * `true` when at least one frame is currently expanded. Drives the
   * collapse-all toggle's icon + tooltip:
   * - expanded present → "Collapse all frames" (`ChevronsDownUp`)
   * - all collapsed    → "Expand all frames"   (`ChevronsUpDown`)
   */
  hasAnyExpandedFrame: boolean;
  /** Bulk collapse / expand toggle handler. */
  onToggleAllFrames: () => void;
  /**
   * When `true` the canvas-wide search has a non-empty query and
   * the layer tree below is replaced by the streamed result list.
   * The bulk collapse/expand-all-frames toggle has nothing to act
   * on in that mode (frame expansion is a tree concept, not a
   * result-list concept), so it's hidden — chips stay visible
   * because they additionally feed `nodeTypes` to the search.
   */
  isSearchActive: boolean;
}

/**
 * Layer-tree toolbar: per-type filter chips + bulk frame
 * collapse/expand toggle.
 *
 * Note on history: this bar used to host a regex "find layers by
 * name" input as well. That input was replaced by the canvas-wide
 * search that lives at the top of the panel (`CanvasSearchInput`)
 * — substring search there covers the same "find by name" workflow
 * and additionally surfaces meta/content/edge-label hits, so having
 * two search inputs in the same panel became redundant. The chip
 * row stayed because it acts on the tree (which is hidden the
 * moment the canvas search has a query); both controls now serve
 * orthogonal axes (explicit type whitelist vs. live query).
 */
export const LayerFilterBar = ({
  availableKeys,
  selectedKeys,
  onToggleKey,
  hasAnyFrame,
  hasAnyExpandedFrame,
  onToggleAllFrames,
  isSearchActive,
}: LayerFilterBarProps) => {
  const { t } = useTranslation();
  const showChipRow = availableKeys.length >= 2;
  const showCollapseAll = hasAnyFrame && !isSearchActive;
  const chipRowRef = useRef<HTMLDivElement>(null);
  const [chipRowWidth, setChipRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = chipRowRef.current;
    if (!row) return;
    const measure = () => setChipRowWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [showChipRow]);

  const capacity = Math.floor(
    (chipRowWidth + FILTER_BUTTON_GAP_PX) /
      (FILTER_BUTTON_WIDTH_PX + FILTER_BUTTON_GAP_PX),
  );
  const visibleCount =
    availableKeys.length <= capacity
      ? availableKeys.length
      : Math.max(0, capacity - 1);
  const visibleKeys = availableKeys.slice(0, visibleCount);
  const overflowKeys = availableKeys.slice(visibleCount);
  const activeOverflowCount = overflowKeys.filter((key) =>
    selectedKeys.has(key),
  ).length;
  const CollapseAllIcon = hasAnyExpandedFrame ? ChevronsDownUp : ChevronsUpDown;
  const collapseAllTitle = hasAnyExpandedFrame
    ? t('layers.collapseAllFrames')
    : t('layers.expandAllFrames');

  if (!showChipRow && !showCollapseAll) return null;

  return (
    <div
      className="bg-surface flex shrink-0 items-center gap-1.5 px-3 py-1"
      data-layer-filter-bar
    >
      <div
        ref={chipRowRef}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
        data-layer-filter-chips
      >
        {showChipRow &&
          // No text label by design — "Filter" is jargon and adds a
          // language barrier; the chips themselves carry the
          // affordance (icon-only buttons with per-type tooltips like
          // "Filter by Image").
          visibleKeys.map((key) => {
            const { icon: Icon } = getFilterKeyMeta(key);
            const label = t(getFilterKeyLabelKey(key));
            const isSelected = selectedKeys.has(key);
            return (
              <Button
                key={key}
                variant="ghost"
                tone={isSelected ? 'info' : 'neutral'}
                iconOnly
                size="sm"
                onClick={() => onToggleKey(key)}
                title={
                  isSelected
                    ? t('layers.stopFilteringBy', { label })
                    : t('layers.filterBy', { label })
                }
                className={clsx(
                  'h-6 w-6 shrink-0 p-1!',
                  isSelected ? 'bg-info-bg!' : 'text-fg-subtle',
                )}
                aria-pressed={isSelected}
                data-layer-filter-key={key}
              >
                <Icon size={14} className="h-3.5! w-3.5!" />
              </Button>
            );
          })}
        {showChipRow && overflowKeys.length > 0 && (
          <DropdownMenu
            floating
            trigger={
              <Button
                variant="ghost"
                tone={activeOverflowCount > 0 ? 'info' : 'neutral'}
                iconOnly
                size="sm"
                tooltipWrapperClassName="flex"
                className={clsx(
                  'h-6 w-6 shrink-0 p-1!',
                  activeOverflowCount > 0 ? 'bg-info-bg!' : 'text-fg-subtle',
                )}
                title={
                  activeOverflowCount > 0
                    ? t('layers.moreFiltersActive', {
                        count: activeOverflowCount,
                      })
                    : t('layers.moreFilters')
                }
              >
                <MoreHorizontal size={14} className="h-3.5! w-3.5!" />
              </Button>
            }
          >
            {overflowKeys.map((key) => {
              const { icon: Icon } = getFilterKeyMeta(key);
              const label = t(getFilterKeyLabelKey(key));
              const isSelected = selectedKeys.has(key);
              return (
                <DropdownMenuItem
                  key={key}
                  icon={
                    <Icon
                      size={14}
                      className={clsx(
                        'h-3.5! w-3.5!',
                        isSelected ? 'text-info' : 'text-fg-subtle',
                      )}
                    />
                  }
                  trailing={
                    isSelected ? (
                      <Check size={14} className="text-info" aria-hidden />
                    ) : undefined
                  }
                  aria-label={
                    isSelected
                      ? t('layers.stopFilteringBy', { label })
                      : t('layers.filterBy', { label })
                  }
                  onClick={() => onToggleKey(key)}
                >
                  {label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenu>
        )}
      </div>
      {showCollapseAll && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onToggleAllFrames}
            title={collapseAllTitle}
            className="text-fg-subtle p-1!"
          >
            <CollapseAllIcon size={14} className="h-3.5! w-3.5!" />
          </Button>
        </div>
      )}
    </div>
  );
};
