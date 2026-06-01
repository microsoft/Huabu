import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { NODE_ICON, NODE_TYPE_LABEL } from '../../../config/nodeIcons';
import { Button } from '../../Common/Button';

import type { CanvasNodeType } from '@sediment/shared';

interface LayerFilterBarProps {
  /** Current regex source (case-insensitive, applied to node labels). */
  query: string;
  onQueryChange: (q: string) => void;
  /**
   * `true` when `query` is non-empty but cannot be compiled as a regex.
   * The input border switches to the danger token to surface the error.
   */
  isRegexInvalid: boolean;
  /**
   * Node types currently present on the canvas, in canonical order. The
   * chip row is built from this list so users never see types that
   * cannot match anything.
   */
  availableTypes: CanvasNodeType[];
  /**
   * Whitelist of node types the user has clicked. An empty set means
   * "no type constraint" — the list shows every type. Otherwise only
   * nodes whose type is in this set survive the filter.
   */
  selectedTypes: Set<CanvasNodeType>;
  onToggleType: (type: CanvasNodeType) => void;
  /** Whether the regex search input row is currently expanded. */
  isSearchOpen: boolean;
  onOpenSearch: () => void;
  /**
   * Collapse the regex input row. The parent is expected to also clear
   * the `query` value so re-opening starts blank, but chip selections
   * are intentionally preserved (they live in their own row and are not
   * tied to the search input's lifecycle).
   */
  onCloseSearch: () => void;
}

export const LayerFilterBar = ({
  query,
  onQueryChange,
  isRegexInvalid,
  availableTypes,
  selectedTypes,
  onToggleType,
  isSearchOpen,
  onOpenSearch,
  onCloseSearch,
}: LayerFilterBarProps) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input every time it opens so users can start
  // typing immediately.
  useEffect(() => {
    if (isSearchOpen) inputRef.current?.focus();
  }, [isSearchOpen]);

  const showChipRow = availableTypes.length >= 2;

  return (
    // The sticky `bg-surface` occludes list rows during scroll, plus a
    // *very* light hairline (~40% of the default edge token) hints at
    // the section boundary without competing with the workspace-header
    // divider above it. Plain `border-edge-default` was too heavy and
    // stacked with that header into "two parallel rules"; a drop shadow
    // looked muddy on the warm-paper background. The diluted hairline
    // splits the difference.
    <div className="bg-surface border-edge-default/40 sticky top-0 z-10 flex flex-col gap-1 border-b px-2 py-1.5">
      {/* Regex search row — only present when the user has explicitly
          opened it. The wrapper is the focus / error surface; the inner
          <input> has no border of its own so the field reads as a single
          continuous control. */}
      {isSearchOpen && (
        <div
          className={clsx(
            'bg-bg-default flex items-center gap-1.5 rounded-md border px-1.5 transition-colors',
            isRegexInvalid
              ? 'border-danger'
              : 'focus-within:border-info border-transparent',
          )}
        >
          <Search
            size={11}
            className={clsx(
              'shrink-0',
              isRegexInvalid ? 'text-danger' : 'text-fg-subtle',
            )}
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCloseSearch();
              }
            }}
            placeholder="Find layers by regex…"
            spellCheck={false}
            className="text-fg-default placeholder:text-fg-subtle min-w-0 flex-1 bg-transparent py-1 text-xs outline-none"
            aria-invalid={isRegexInvalid || undefined}
          />
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            onClick={onCloseSearch}
            title="Close search (Esc)"
            className="p-0.5!"
          >
            <X size={11} />
          </Button>
        </div>
      )}

      {/* Default chip row — the "always there" affordance. Chips on the
          left whitelist node types; the Search button on the right opens
          the regex input above. Hidden when fewer than two node types
          exist on the canvas (the parent then falls back to a corner-
          floating Search trigger). */}
      {showChipRow && (
        // No text label by design — "Filter" is jargon and adds a
        // language barrier; the chips themselves carry the affordance
        // (icon-only buttons with per-type tooltips like "Filter by
        // Image"). The search trigger sits on the right as the only
        // explicit non-chip control on this row.
        <div className="flex items-center gap-1.5">
          <div className="flex flex-1 flex-wrap items-center gap-0.5">
            {availableTypes.map((type) => {
              const Icon = NODE_ICON[type];
              const isSelected = selectedTypes.has(type);
              return (
                <Button
                  key={type}
                  variant="ghost"
                  tone={isSelected ? 'info' : 'neutral'}
                  iconOnly
                  size="sm"
                  shape="pill"
                  onClick={() => onToggleType(type)}
                  title={
                    isSelected
                      ? `Stop filtering by ${NODE_TYPE_LABEL[type]}`
                      : `Filter by ${NODE_TYPE_LABEL[type]}`
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
          {!isSearchOpen && (
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              onClick={onOpenSearch}
              title="Find by regex"
              className="text-fg-muted shrink-0 p-1!"
            >
              <Search size={12} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
