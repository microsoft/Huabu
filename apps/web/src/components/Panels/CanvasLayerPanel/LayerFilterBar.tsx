// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { ChevronsDownUp, ChevronsUpDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getFilterKeyLabelKey, getFilterKeyMeta } from './layerFilterKey';
import { formatShortcutById } from '../../../config/shortcuts';
import { Button } from '../../Common/Button';

import type { LayerFilterKey } from './layerFilterKey';

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
   * "no type constraint" — the list shows every type. Otherwise only
   * nodes whose key is in this set survive the filter.
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
  /**
   * Drives the search toggle button's pressed state + tooltip.
   * `true` while the canvas search input is revealed (mounted in
   * the panel above this bar), `false` while it's hidden.
   */
  isSearchOpen: boolean;
  /** Toggle the canvas search input's visibility (panel state). */
  onToggleSearch: () => void;
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
 * orthogonal axes (type whitelist vs. live query).
 */
export const LayerFilterBar = ({
  availableKeys,
  selectedKeys,
  onToggleKey,
  hasAnyFrame,
  hasAnyExpandedFrame,
  onToggleAllFrames,
  isSearchActive,
  isSearchOpen,
  onToggleSearch,
}: LayerFilterBarProps) => {
  const { t } = useTranslation();
  const showChipRow = availableKeys.length >= 2;
  const showCollapseAll = hasAnyFrame && !isSearchActive;
  const CollapseAllIcon = hasAnyExpandedFrame ? ChevronsDownUp : ChevronsUpDown;
  const collapseAllTitle = hasAnyExpandedFrame
    ? t('layers.collapseAllFrames')
    : t('layers.expandAllFrames');

  // The search toggle is the bar's permanent anchor — once the
  // toggle moved into this row, the bar always has at least one
  // affordance to render, so the previous empty-state early-return
  // would only fire on the (impossible) "toggle missing" path. The
  // chip row and collapse-all toggle remain conditional alongside it.

  return (
    <div className="bg-surface border-edge-default/40 flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
      <div className="flex flex-1 flex-wrap items-center gap-0.5">
        {showChipRow &&
          // No text label by design — "Filter" is jargon and adds a
          // language barrier; the chips themselves carry the
          // affordance (icon-only buttons with per-type tooltips like
          // "Filter by Image").
          availableKeys.map((key) => {
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
                shape="pill"
                onClick={() => onToggleKey(key)}
                title={
                  isSelected
                    ? t('layers.stopFilteringBy', { label })
                    : t('layers.filterBy', { label })
                }
                className={clsx(
                  'p-1!',
                  isSelected ? 'bg-info-bg!' : 'text-fg-muted',
                )}
                aria-pressed={isSelected}
              >
                <Icon size={12} />
              </Button>
            );
          })}
      </div>
      {showCollapseAll && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onToggleAllFrames}
            title={collapseAllTitle}
            className="text-fg-muted p-1!"
          >
            <CollapseAllIcon size={12} />
          </Button>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          tone={isSearchOpen ? 'info' : 'neutral'}
          iconOnly
          size="sm"
          onClick={onToggleSearch}
          title={
            isSearchOpen
              ? `${t('layers.closeSearch')} (${formatShortcutById('search.close')})`
              : `${t('layers.searchCanvas')} (${formatShortcutById('search.open')})`
          }
          className={clsx(
            'p-1!',
            isSearchOpen ? 'bg-info-bg!' : 'text-fg-muted',
          )}
          aria-pressed={isSearchOpen}
        >
          <Search size={12} />
        </Button>
      </div>
    </div>
  );
};
