// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React from 'react';

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
}

/**
 * A single setting row inside a {@link SettingSection} card. Renders the
 * title (and optional description) on the left and a control on the right.
 * The row itself is borderless — dividers come from the parent section.
 */
export const SettingRow: React.FC<SettingRowProps> = ({
  title,
  description,
  labelFor,
  leading,
  children,
  className = '',
  density = 'default',
}) => {
  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 ${density === 'compact' ? 'py-1.5' : 'py-2.5'} ${className}`.trim()}
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
      <div className="shrink-0">{children}</div>
    </div>
  );
};
