import { forwardRef } from 'react';

import { Tooltip } from './Tooltip';

import type { InputHTMLAttributes } from 'react';

export type InputProps = {
  wrapperClassName?: string;
  /** Distance in px between the input and the tooltip. Defaults to 8. */
  tooltipOffset?: number;
} & InputHTMLAttributes<HTMLInputElement>;

/**
 * A drop-in replacement for <input> that renders the `title` prop using the
 * shared Tooltip component instead of the native browser tooltip.
 * No default styles are applied — pass `className` as usual.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ wrapperClassName, tooltipOffset, title, ...props }, ref) => {
    const inputEl = <input ref={ref} {...props} />;

    return title ? (
      <Tooltip
        content={title}
        wrapperClassName={wrapperClassName}
        offset={tooltipOffset}
      >
        {inputEl}
      </Tooltip>
    ) : (
      inputEl
    );
  },
);

Input.displayName = 'Input';
