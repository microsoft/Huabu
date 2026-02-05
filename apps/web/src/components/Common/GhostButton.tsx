import { Tooltip } from './Tooltip';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type GhostButtonProps = {
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

export const GhostButton = ({
  children,
  className,
  type = 'button',
  title,
  ...props
}: GhostButtonProps) => {
  const buttonEl = (
    <button
      type={type}
      className={[
        'inline-flex cursor-pointer items-center justify-center rounded border-none bg-transparent p-1 transition-colors',
        'enabled:hover:bg-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </button>
  );

  return title ? <Tooltip content={title}>{buttonEl}</Tooltip> : buttonEl;
};
