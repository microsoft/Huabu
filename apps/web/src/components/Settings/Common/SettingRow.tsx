// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React from 'react';

import { cn } from '@/components/Common/cn';

interface SettingRowProps {
  /** Primary label for the setting. Omit when the section heading already names it. */
  title?: React.ReactNode;
  /** Optional secondary description text. */
  description?: string;
  /** Associates the title with a form control id. */
  labelFor?: string;
  /** Optional adornment rendered before the text column (e.g. an avatar). */
  leading?: React.ReactNode;
  /** Control element rendered on the right (e.g. Button, Toggle, Select, link icon). */
  children: React.ReactNode;
  /** Additional class names for the row element. */
  className?: string;
  /** Reduces vertical padding for subordinate settings. */
  density?: 'default' | 'compact';
  /** Places controls beside the label or in a full-width row below it. */
  layout?: 'inline' | 'stacked';
}

/**
 * A single setting row inside a {@link SettingSection} card. Renders the
 * title (and optional description) with its controls. Inline rows place the
 * control on the right; stacked rows place it full-width below the text. The
 * row itself is borderless — dividers come from the parent section.
 */
export const SettingRow: React.FC<SettingRowProps> = ({
  title,
  description,
  labelFor,
  leading,
  children,
  className = '',
  density = 'default',
  layout = 'inline',
}) => {
  const stacked = layout === 'stacked';

  return (
    <div
      className={cn(
        'flex gap-3 px-3',
        stacked ? 'flex-col items-stretch' : 'items-center justify-between',
        density === 'compact' ? 'py-1.5' : 'py-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {leading && <div className="shrink-0">{leading}</div>}
        <div className="min-w-0 flex-1">
          {title &&
            (labelFor ? (
              <label
                htmlFor={labelFor}
                className="text-fg-default block cursor-pointer text-xs font-medium"
              >
                {title}
              </label>
            ) : (
              <p className="text-fg-default text-xs font-medium">{title}</p>
            ))}
          {description && (
            <p className="text-fg-subtle mt-0.5 text-[11px] leading-snug">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className={stacked ? 'w-full min-w-0' : 'shrink-0'}>{children}</div>
    </div>
  );
};
