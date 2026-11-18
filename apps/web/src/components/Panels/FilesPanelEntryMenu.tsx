// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { MoreHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { copyToClipboard } from '@/utils/io/clipboard';

import {
  SIDEBAR_ROW_ACTION_CLASS,
  SIDEBAR_ROW_INSET_CLASS,
  SIDEBAR_ROW_SURFACE_CLASS,
  sidebarRowBackground,
} from './sidebarRowStyles';

type FilesPanelEntryMenuProps = {
  name: string;
  path: string;
  relativePath: string;
  onCopyResult: (copied: boolean) => void;
  /** The entry is the one open in Preview. */
  selected?: boolean;
  /** Folders only: make this folder the root of the tree. */
  onOpenHere?: () => void;
  /** Files only: open a reference card for this entry, adding one if needed. */
  onOpen?: () => void;
  /** Files only: place a reference card for this entry in the Space. */
  onAdd?: () => void;
  /** Whether the Space can take a new reference card. */
  canAdd?: boolean;
  children: ReactNode;
};

export function FilesPanelEntryMenu({
  name,
  path,
  relativePath,
  onCopyResult,
  selected,
  onOpenHere,
  onOpen,
  onAdd,
  canAdd = false,
  children,
}: FilesPanelEntryMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const copy = async (value: string) => {
    try {
      await copyToClipboard(value);
      onCopyResult(true);
    } catch {
      onCopyResult(false);
    } finally {
      setOpen(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={name}
      // A sidebar row like those in Layers, only a little shorter: a
      // directory has far more rows than a Space.
      className={cn(
        'group/sidebar-row flex h-7.5 items-center',
        SIDEBAR_ROW_INSET_CLASS,
      )}
      onKeyDownCapture={(event) => {
        if (
          event.key === 'ContextMenu' ||
          (event.shiftKey && event.key === 'F10')
        ) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }}
    >
      {/* One surface for the entry and its actions, so hovering either
          lights the whole row. */}
      <div
        className={cn(
          // Keyboard focus rings the whole row, not just the name inside it.
          'has-[:focus-visible]:ring-info flex h-7 w-full min-w-0 items-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset',
          SIDEBAR_ROW_SURFACE_CLASS,
          sidebarRowBackground({ selected }),
          open && !selected && 'bg-hover',
        )}
      >
        <div className="h-full min-w-0 flex-1">{children}</div>
        <DropdownMenu
          aria-label={name}
          open={open}
          onOpenChange={setOpen}
          triggerWrapperClassName="flex shrink-0 pr-1"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              title={t('files.entryActions', { name })}
              className={cn(
                'min-h-5! min-w-5! p-0.5!',
                // Touch has no hover to reveal the button with.
                open
                  ? 'text-fg-default'
                  : cn(
                      SIDEBAR_ROW_ACTION_CLASS,
                      '[@media(hover:none)]:opacity-100',
                    ),
              )}
              onKeyDown={(event) => {
                if (
                  event.key === 'ContextMenu' ||
                  (event.shiftKey && event.key === 'F10')
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(true);
                }
              }}
            >
              <MoreHorizontal />
            </Button>
          }
        >
          <div
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <DropdownMenuItem onClick={() => void copy(name)}>
              {t('files.copyName')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copy(relativePath)}>
              {t('files.copyRelativePath')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copy(path)}>
              {t('files.copyFullPath')}
            </DropdownMenuItem>
            {onOpenHere ? (
              <DropdownMenuItem
                onClick={() => {
                  setOpen(false);
                  onOpenHere();
                }}
              >
                {t('files.openHere')}
              </DropdownMenuItem>
            ) : null}
            {onOpen ? (
              <DropdownMenuItem
                onClick={() => {
                  setOpen(false);
                  onOpen();
                }}
              >
                {t('files.openPreview')}
              </DropdownMenuItem>
            ) : null}
            {onAdd ? (
              <DropdownMenuItem
                disabled={!canAdd}
                onClick={() => {
                  setOpen(false);
                  onAdd();
                }}
              >
                {t('files.addToSpace')}
              </DropdownMenuItem>
            ) : null}
          </div>
        </DropdownMenu>
      </div>
    </div>
  );
}
