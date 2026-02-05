import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type PillButtonProps = {
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

export const PillButton = ({
  children,
  className,
  type = 'button',
  ...props
}: PillButtonProps) => {
  return (
    <button
      type={type}
      className={[
        'border-border inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium text-gray-700',
        'hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </button>
  );
};
