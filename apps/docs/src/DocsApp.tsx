// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { DocsLayout } from './DocsLayout';
import { allRoutes } from './navigation';
import { NotFound } from './NotFound';

export function DocsApp() {
  return (
    <DocsLayout>
      <RouteTitle />
      <Suspense fallback={<DocsFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/docs" replace />} />
          {allRoutes.map(({ to, Component }) => (
            <Route key={to} path={to} element={<Component />} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </DocsLayout>
  );
}

function RouteTitle() {
  const { pathname } = useLocation();

  useEffect(() => {
    const route = allRoutes.find((candidate) => candidate.to === pathname);
    document.title = route
      ? `${route.label} · Huabu Handbook`
      : 'Huabu Handbook';
  }, [pathname]);

  return null;
}

function DocsFallback() {
  return (
    <div
      data-docs-loading
      className="flex items-center gap-3 px-8 py-12 text-sm text-gray-500"
    >
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" />
      Loading…
    </div>
  );
}
