import { Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { DocsLayout } from './DocsLayout';
import { allRoutes } from './navigation';

/**
 * Top-level handbook page, mounted at `/docs/*` in the app router.
 *
 * Sidebar and route table are both derived from `navigation.ts`, so
 * adding or moving a section there propagates everywhere.
 */
export default function DocsPage() {
  useEffect(() => {
    // Reflect the section in the browser tab while users are reading;
    // restore on unmount so other pages keep ownership of the title.
    const previous = document.title;
    document.title = 'Handbook · Huabu';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <DocsLayout>
      <Suspense fallback={<DocsFallback />}>
        <Routes>
          {allRoutes.map(({ to, Component }) => (
            <Route
              key={to}
              // `to` is absolute (`/docs/...`); strip the mount prefix
              // so each entry registers a path relative to `<Routes>`.
              path={to.replace(/^\/docs\/?/, '') || undefined}
              index={to === '/docs' || undefined}
              element={<Component />}
            />
          ))}
          <Route path="*" element={<Navigate to="/docs" replace />} />
        </Routes>
      </Suspense>
    </DocsLayout>
  );
}

function DocsFallback() {
  return (
    <div className="flex items-center gap-3 px-8 py-12 text-sm text-gray-500">
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
      Loading…
    </div>
  );
}
