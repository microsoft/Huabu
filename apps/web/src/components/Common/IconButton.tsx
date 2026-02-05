import { Tooltip } from './Tooltip';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonProps = {
  children: ReactNode;
  size?: 'sm' | 'md';
  variant?: 'outline' | 'solid';
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

export const IconButton = ({
  children,
  size = 'md',
  variant = 'outline',
  className,
  type = 'button',
  title,
  ...props
}: IconButtonProps) => {
  const sizeClass = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';

  const variantClass =
    variant === 'solid'
      ? 'bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40'
      : 'border border-border text-gray-600 hover:bg-gray-50 disabled:opacity-50';

  const buttonEl = (
    <button
      type={type}
      className={[
        'inline-flex items-center justify-center rounded-full',
        sizeClass,
        variantClass,
        'disabled:cursor-not-allowed',
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
