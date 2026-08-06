// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useId } from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * A styled iOS-style toggle switch using design system tokens.
 */
export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  label,
}) => {
  const id = useId();

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? 'Toggle'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
        'transition-colors duration-200 ease-in-out',
        'focus-visible:ring-info focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
        checked ? 'bg-info' : 'bg-edge-default',
        disabled ? 'cursor-not-allowed opacity-50' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        className={[
          'bg-surface pointer-events-none inline-block h-4 w-4 rounded-full shadow-sm',
          'transition-transform duration-200 ease-in-out',
          checked ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
};
