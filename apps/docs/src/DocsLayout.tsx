// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Github, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { withBasePath } from './basePath';
import { cn } from './components/cn';
import { Search } from './components/Search';
import { groups, pinnedItems, type DocsItem } from './navigation';

import type { CSSProperties, ReactNode } from 'react';

/**
 * Shell for every page on the standalone handbook site.
 *
 * Layout:
 * - On `lg` and up: a floating sidebar pinned to the viewport on the
 *   left (logo + pinned shortcuts always visible; groups scroll
 *   below), and the main content area on the right owns the article.
 * - Below `lg`: the sidebar collapses into a slide-in drawer toggled
 *   from a sticky mobile header, and the main content spans the full
 *   width with compact side padding.
 *
 * Horizontal spacing on `lg`+ (kept consistent across every section
 * page):
 * - Sidebar occupies `left-4 + w-60` = 256px from the viewport's
 *   left edge to its right edge.
 * - `--docs-gutter` (= 1/5 of the space remaining after the sidebar)
 *   is applied as both the left padding (sidebar → content) and the
 *   right padding (toc → viewport edge).
 * - Content-to-TOC gap is `4vw` (set inside `PageLayout`).
 *
 * The module has no product-application dependency.
 */
export function DocsLayout({ children }: { children: ReactNode }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the mobile drawer on navigation so tapping a link doesn't
  // leave the overlay covering the freshly loaded page.
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!isSidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isSidebarOpen]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!isSidebarOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSidebarOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isSidebarOpen]);

  return (
    <div
      className="relative h-full w-full overflow-y-auto bg-white"
      style={
        {
          // Single source of truth for the side gutters. Tweak here
          // and both PageLayout's padding and the TOC offset move
          // together.
          '--docs-sidebar-right-edge': '256px',
          '--docs-gutter':
            'calc((100vw - var(--docs-sidebar-right-edge)) / 10)',
        } as CSSProperties
      }
    >
      <MobileHeader onOpen={() => setIsSidebarOpen(true)} />

      {/* Backdrop for the mobile drawer. */}
      {isSidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <DocsSidebar
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />
      <main className="min-h-full px-5 pt-14.25 lg:px-0 lg:pt-0 lg:pl-[calc(var(--docs-sidebar-right-edge)+var(--docs-gutter))] lg:pr-(--docs-gutter)">
        {children}
      </main>
    </div>
  );
}

function MobileHeader({ onOpen }: { onOpen: () => void }) {
  return (
    <header className="fixed top-0 right-0 left-0 z-20 flex items-center gap-3 border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open navigation"
        className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 transition-colors hover:bg-gray-100"
      >
        <Menu aria-hidden="true" className="h-5 w-5" />
      </button>
      <a
        href={withBasePath('/')}
        aria-label="Huabu home"
        title="Huabu home"
        className="rounded transition-opacity hover:opacity-70"
      >
        <img src={withBasePath('favicon.svg')} alt="" className="h-5 w-5" />
      </a>
      <Link
        to="/docs"
        className="text-[15px] font-semibold text-gray-900 transition-colors hover:text-gray-600"
      >
        Handbook
      </Link>
    </header>
  );
}

const sidebarLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'block rounded-md px-3 py-1.5 text-[13.5px] transition-colors',
    isActive
      ? 'bg-gray-100 font-medium text-gray-900'
      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
  );

function DocsSidebar({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <aside
      className={cn(
        'fixed top-4 bottom-4 left-4 z-40 flex w-60 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out lg:z-20 lg:translate-x-0',
        isOpen ? 'translate-x-0' : '-translate-x-[calc(100%+1rem)]',
      )}
    >
      {/* Pinned header: logo + brand + the two universal entry points
              (Overview / Quick Start). Stays put when the lower list
              scrolls. */}
      <div className="shrink-0 border-b border-gray-100 px-4 pt-4 pb-3">
        <div className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-gray-900">
          <a
            href={withBasePath('/')}
            aria-label="Huabu home"
            title="Huabu home"
            className="rounded transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <img src={withBasePath('favicon.svg')} alt="" className="h-5 w-5" />
          </a>
          <Link to="/docs" className="transition-colors hover:text-gray-600">
            Handbook
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 lg:hidden"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
        <Search />
        <ul className="space-y-0.5">
          {pinnedItems.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end className={sidebarLinkClass}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      {/* Scrollable group list: flat (no collapse), each group has a
          bold title above its items. */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ul className="space-y-5">
          {groups.map((group) => (
            <li key={group.label}>
              <div className="mb-1.5 px-3 text-[13px] font-semibold tracking-wide text-gray-700 uppercase">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item: DocsItem) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end className={sidebarLinkClass}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
      <div className="shrink-0 border-t border-gray-100 px-4 py-3">
        <a
          href="https://github.com/microsoft/Huabu"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
        >
          <Github aria-hidden="true" className="h-4 w-4" />
          <span>GitHub</span>
          <span className="ml-auto" aria-hidden="true">
            ↗
          </span>
        </a>
      </div>
    </aside>
  );
}
