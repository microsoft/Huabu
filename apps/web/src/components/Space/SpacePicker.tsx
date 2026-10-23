// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { FLOATING_TOOLBAR_POPOVER_CLASS } from '@/components/Common/FloatingToolbar';
import { Popover } from '@/components/Common/Popover';
import { Spinner } from '@/components/Common/Spinner';
import { TextInput } from '@/components/Common/TextInput';
import { NODE_ICON } from '@/config/nodeIcons';

import type { SelectOption } from '@/components/Common/Select';

export interface SpacePickerOption extends SelectOption<string> {
  parentValue?: string | null;
  disabledReason?: string;
}

interface SpacePickerProps {
  reference?: Element | null;
  boundary?: HTMLElement | null;
  title: string;
  searchLabel: string;
  loadingLabel: string;
  errorLabel: string;
  emptyLabel: string;
  footer?: ReactNode;
  placement?: 'bottom-start' | 'top-start';
  currentSpaceId?: string;
  options: SpacePickerOption[];
  loading?: boolean;
  loadError?: boolean;
  submitting?: boolean;
  onClose: () => void;
  onSubmit: (canvasId: string) => void;
}

export function SpacePicker({
  reference,
  boundary,
  title,
  searchLabel,
  loadingLabel,
  errorLabel,
  emptyLabel,
  footer,
  placement = 'bottom-start',
  currentSpaceId,
  options,
  loading,
  loadError,
  submitting,
  onClose,
  onSubmit,
}: SpacePickerProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const search = query.trim().toLocaleLowerCase();
  const { children, defaults, rows } = useMemo(() => {
    const byId = new Map(options.map((option) => [option.value, option]));
    const children = new Map<string | null, SpacePickerOption[]>();
    for (const option of options) {
      const parent =
        option.parentValue && byId.has(option.parentValue)
          ? option.parentValue
          : null;
      const siblings = children.get(parent) ?? [];
      siblings.push(option);
      children.set(parent, siblings);
    }
    const defaults = new Set<string>();
    let ancestor = currentSpaceId;
    while (ancestor && !defaults.has(ancestor)) {
      defaults.add(ancestor);
      ancestor = byId.get(ancestor)?.parentValue ?? undefined;
    }
    const rows: Array<{ option: SpacePickerOption; depth: number }> = [];
    if (search) {
      for (const option of options) {
        if (
          `${option.label} ${option.description ?? ''}`
            .toLocaleLowerCase()
            .includes(search)
        ) {
          rows.push({ option, depth: 0 });
        }
      }
    } else {
      const seen = new Set<string>();
      const visit = (parent: string | null, depth: number) => {
        for (const option of children.get(parent) ?? []) {
          if (seen.has(option.value)) continue;
          seen.add(option.value);
          rows.push({ option, depth });
          if (expansion[option.value] ?? defaults.has(option.value))
            visit(option.value, depth + 1);
        }
      };
      visit(null, 0);
    }
    return { children, defaults, rows };
  }, [options, currentSpaceId, search, expansion]);

  const navigateResults = (
    event: KeyboardEvent<HTMLElement>,
    option?: SpacePickerOption,
  ) => {
    if (
      option &&
      !search &&
      children.has(option.value) &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      setExpansion((previous) => ({
        ...previous,
        [option.value]: event.key === 'ArrowRight',
      }));
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-space-nav]:not(:disabled)',
      ) ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    const next = current + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) searchRef.current?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };

  return (
    <Popover
      reference={reference}
      boundary={boundary}
      placement={placement}
      onOpenAutoFocus={() => searchRef.current?.focus()}
      onDismiss={
        submitting
          ? undefined
          : (reason) => {
              onClose();
              if (reason === 'escape' && reference instanceof HTMLElement)
                reference.focus();
            }
      }
      className={cn(
        FLOATING_TOOLBAR_POPOVER_CLASS,
        'w-[360px] max-w-[calc(100vw-2rem)] p-2',
      )}
    >
      <div
        role="dialog"
        aria-labelledby={titleId}
        aria-busy={loading || submitting}
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>
        <div className="relative mb-3">
          <Search
            aria-hidden="true"
            size={16}
            className="text-fg-subtle pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
          <TextInput
            ref={searchRef}
            size="field"
            className="h-9 w-full pl-9"
            name="space-destination-search"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => navigateResults(event)}
            disabled={submitting}
          />
        </div>
        <p className="text-fg-subtle px-2 pb-1 text-xs font-medium">
          {t('moveSelection.spaces')}
        </p>
        {loading || submitting ? (
          <div
            role="status"
            className="text-fg-muted flex items-center gap-2 px-2 py-3 text-sm"
          >
            <Spinner size="sm" />
            {loadingLabel}
          </div>
        ) : loadError ? (
          <p role="alert" className="text-danger px-2 py-3 text-sm">
            {errorLabel}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-fg-muted px-2 py-3 text-sm">{emptyLabel}</p>
        ) : (
          <ul
            ref={listRef}
            aria-label={t('moveSelection.spaces')}
            className="max-h-72 overflow-y-auto"
          >
            {rows.map(({ option, depth }) => {
              const hasChildren = !search && children.has(option.value);
              const expanded =
                expansion[option.value] ?? defaults.has(option.value);
              return (
                <li
                  key={option.value}
                  className="flex min-w-0 items-center"
                  style={{ paddingLeft: Math.min(depth, 8) * 16 }}
                >
                  {hasChildren ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      className="shrink-0"
                      aria-expanded={expanded}
                      aria-label={t(
                        expanded
                          ? 'moveSelection.collapse'
                          : 'moveSelection.expand',
                        { name: option.label },
                      )}
                      data-space-nav={option.disabled ? '' : undefined}
                      onKeyDown={(event) => navigateResults(event, option)}
                      onClick={() =>
                        setExpansion((previous) => ({
                          ...previous,
                          [option.value]: !expanded,
                        }))
                      }
                    >
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  ) : (
                    <span className="w-6 shrink-0" />
                  )}
                  <Button
                    variant="ghost"
                    size="field"
                    className="text-fg-default h-8 w-full min-w-0 justify-start px-1.5 text-left font-normal"
                    tooltipWrapperClassName="min-w-0 flex-1"
                    title={
                      option.disabledReason ??
                      [option.description, option.label]
                        .filter(Boolean)
                        .join(' / ')
                    }
                    aria-label={option.label}
                    disabled={option.disabled}
                    data-space-nav=""
                    onClick={() => onSubmit(option.value)}
                    onKeyDown={(event) => navigateResults(event, option)}
                  >
                    <NODE_ICON.spacePreview className="text-fg-muted shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    {search && option.description && (
                      <span className="text-fg-subtle max-w-[40%] truncate text-xs">
                        {option.description}
                      </span>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {footer && (
          <div className="border-edge-default text-fg-subtle mt-2 border-t px-2 pt-2 text-xs">
            {footer}
          </div>
        )}
      </div>
    </Popover>
  );
}
