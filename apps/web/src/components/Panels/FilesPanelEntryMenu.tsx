// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { MoreHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { copyToClipboard } from '@/utils/io/clipboard';

type FilesPanelEntryMenuProps = {
  name: string;
  path: string;
  relativePath: string;
  onCopyResult: (copied: boolean) => void;
  children: ReactNode;
};

export function FilesPanelEntryMenu({
  name,
  path,
  relativePath,
  onCopyResult,
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
      className="group/files-row flex items-center"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <DropdownMenu
        aria-label={name}
        open={open}
        onOpenChange={setOpen}
        triggerWrapperClassName="shrink-0 pr-1"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title={t('files.entryActions', { name })}
            className={
              open
                ? undefined
                : 'opacity-0 group-hover/files-row:opacity-100 focus-visible:opacity-100'
            }
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
        </div>
      </DropdownMenu>
    </div>
  );
}
