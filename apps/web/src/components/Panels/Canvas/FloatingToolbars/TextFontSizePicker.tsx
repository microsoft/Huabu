// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { FloatingToolbar } from '@/components/Common/FloatingToolbar';

export function TextFontSizePicker({
  value,
  onApply,
}: {
  value: number | null;
  onApply: (fontSize: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="node-toolbar-font-size">
      <FloatingToolbar.NumberInput
        label=""
        ariaLabel={t('toolbar.fontSize')}
        title={t('toolbar.fontSize')}
        name="font-size"
        value={value}
        min={8}
        max={160}
        unstyled
        onApply={onApply}
      />
      <DropdownMenu
        floating
        open={open}
        onOpenChange={setOpen}
        className="node-toolbar-font-menu"
        align="bottom-right"
        trigger={
          <Button
            variant="ghost"
            iconOnly
            title={t('toolbar.fontSize')}
            className="node-toolbar-font-trigger"
          >
            <ChevronDown />
          </Button>
        }
      >
        {[
          8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96, 120, 160,
        ].map((fontSize) => (
          <DropdownMenuItem
            key={fontSize}
            aria-current={value === fontSize ? 'true' : undefined}
            trailing={value === fontSize ? <Check size={14} /> : undefined}
            onClick={() => {
              onApply(fontSize);
              setOpen(false);
            }}
          >
            {fontSize}
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
    </div>
  );
}
