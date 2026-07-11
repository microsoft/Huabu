import { Link, NavLink } from 'react-router-dom';

import { withBasePath } from './basePath';
import { cn } from './components/cn';
import { Search } from './components/Search';
import { groups, pinnedItems, type DocsItem } from './navigation';

import type { CSSProperties, ReactNode } from 'react';

/**
 * Shell for every page on the standalone handbook site.
 *
 * Layout:
 * - Floating sidebar pinned to the viewport on the left (logo +
 *   pinned shortcuts always visible; groups scroll below).
 * - Main content area on the right owns the article content.
 *
 * Horizontal spacing (kept consistent across every section page):
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
  return (
    <div
      className="relative h-full w-full overflow-y-auto bg-white bg-[radial-gradient(circle,_rgba(0,0,0,0.12)_1px,_transparent_1px)] bg-[length:22px_22px]"
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
      <DocsSidebar />
      <main
        className="min-h-full"
        style={{
          paddingLeft:
            'calc(var(--docs-sidebar-right-edge) + var(--docs-gutter))',
          paddingRight: 'var(--docs-gutter)',
        }}
      >
        {children}
      </main>
    </div>
  );
}

const sidebarLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'block rounded-md px-3 py-1.5 text-[13.5px] transition-colors',
    isActive
      ? 'bg-gray-100 font-medium text-gray-900'
      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
  );

function DocsSidebar() {
  return (
    <aside className="fixed top-4 bottom-4 left-4 z-20 flex w-60 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
      {/* Pinned header: logo + brand + the two universal entry points
          (Overview / Quick Start). Stays put when the lower list
          scrolls. */}
      <div className="shrink-0 border-b border-gray-100 px-4 pt-4 pb-3">
        <Link
          to="/docs"
          className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-gray-900"
        >
          <img src={withBasePath('favicon.svg')} alt="" className="h-5 w-5" />
          <span>Huabu Handbook</span>
        </Link>
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

      {/* The standalone site links to the public project, not an app route. */}
      <div className="shrink-0 border-t border-gray-100 px-4 py-3 text-[12px] text-gray-500">
        <a
          href="https://github.com/cxxxxxn/Sediment"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-gray-900"
        >
          View project on GitHub ↗
        </a>
      </div>
    </aside>
  );
}
