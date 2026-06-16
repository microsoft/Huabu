import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { getFilterKeyMeta } from './layerFilterKey';
import { Button } from '../../Common/Button';

import type { LayerFilterKey } from './layerFilterKey';

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
  availableKeys,
  selectedKeys,
  onToggleKey,
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

  const showChipRow = availableKeys.length >= 2;

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
            {availableKeys.map((key) => {
              const { icon: Icon, label } = getFilterKeyMeta(key);
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
                      ? `Stop filtering by ${label}`
                      : `Filter by ${label}`
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
