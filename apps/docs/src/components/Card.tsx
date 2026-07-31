// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Navigation card — a one-third-width hover card used on hub pages
 * (e.g. Overview) to surface key sections.
 *
 * Render a `<CardGrid>` and place 1–3 `<NavCard>`s inside per row.
 */

import { ArrowUpRight } from 'lucide-react';
import { useRef } from 'react';
import { Link } from 'react-router';

import { withBasePath } from '../basePath';
import { cn } from './cn';

import type { LucideIcon } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

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
  /** Optional banner image rendered above the text. */
  image?: string;
  /** Alt text for `image`. Falls back to `title`. */
  imageAlt?: string;
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
  image,
  imageAlt,
  className,
}: NavCardProps) {
  const isInternal = to.startsWith('/') && !to.startsWith('//');
  const bannerRef = useRef<HTMLDivElement | null>(null);

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    const el = bannerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty('--mx', `${x}%`);
    el.style.setProperty('--my', `${y}%`);
  };

  const banner = (
    <div
      ref={bannerRef}
      onMouseMove={handleMove}
      className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-gray-50 to-gray-100"
      style={{ '--mx': '50%', '--my': '50%' } as React.CSSProperties}
    >
      {image ? (
        <img
          src={image.startsWith('/') ? withBasePath(image) : image}
          alt={imageAlt ?? title}
          className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
        />
      ) : (
        Icon && (
          <div className="relative z-10 flex h-full w-full items-center justify-center text-gray-400 transition-transform duration-500 ease-out group-hover:scale-105">
            <Icon className="h-10 w-10" strokeWidth={1.25} />
          </div>
        )
      )}
      {/* Soft blue/purple wash that fills the whole banner on hover.
          The two cursor-driven CSS vars (--mx/--my) only shift the
          colour balance slightly so the wash feels alive without
          becoming a tight spotlight. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 blur-2xl transition-opacity duration-500 ease-out group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(120% 120% at var(--mx) var(--my), rgba(176, 200, 255, 0.45), rgba(208, 188, 255, 0.3) 55%, rgba(230, 215, 255, 0.18) 100%)',
        }}
      />
    </div>
  );

  const inner = (
    <>
      {banner}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          {eyebrow && (
            <span className="text-[10.5px] font-medium tracking-wide text-gray-500 uppercase">
              {eyebrow}
            </span>
          )}
          <ArrowUpRight className="ml-auto h-4 w-4 text-gray-400 transition-transform duration-300 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-gray-700" />
        </div>
        <div className="mt-1.5 text-[14px] font-semibold text-gray-900">
          {title}
        </div>
        {description && (
          <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-gray-600">
            {description}
          </div>
        )}
      </div>
    </>
  );

  const classes = cn(
    'group relative block overflow-hidden rounded-2xl border border-gray-200 bg-white transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md',
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
