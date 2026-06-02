/**
 * Navigation card — a one-third-width hover card used on hub pages
 * (e.g. Overview) to surface key sections.
 *
 * Render a `<CardGrid>` and place 1–3 `<NavCard>`s inside per row.
 */

import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { cn } from './cn';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

type NavCardProps = {
  to: string;
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Optional small label like "Core" / "Reference". */
  eyebrow?: string;
  className?: string;
};

/**
 * A clickable card with a subtle hover lift. Designed to occupy
 * 1/3 of the content row inside a `<CardGrid>`.
 */
export function NavCard({
  to,
  icon: Icon,
  title,
  description,
  eyebrow,
  className,
}: NavCardProps) {
  const isInternal = to.startsWith('/') && !to.startsWith('//');

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {Icon && (
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
              <Icon className="h-4 w-4" />
            </span>
          )}
          {eyebrow && (
            <span className="text-[11px] font-medium tracking-wide text-gray-500 uppercase">
              {eyebrow}
            </span>
          )}
        </div>
        <ArrowUpRight className="h-4 w-4 text-gray-400 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-gray-700" />
      </div>
      <div className="mt-3 text-[15px] font-semibold text-gray-900">
        {title}
      </div>
      {description && (
        <div className="mt-1.5 text-[13px] leading-relaxed text-gray-600">
          {description}
        </div>
      )}
    </>
  );

  const classes = cn(
    'group relative block rounded-2xl border border-gray-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md',
    className,
  );

  return isInternal ? (
    <Link to={to} className={classes}>
      {inner}
    </Link>
  ) : (
    <a href={to} target="_blank" rel="noopener noreferrer" className={classes}>
      {inner}
    </a>
  );
}
