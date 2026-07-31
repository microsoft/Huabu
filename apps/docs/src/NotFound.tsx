// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Link } from 'react-router';

export function NotFound() {
  return (
    <article
      data-pagefind-ignore
      className="mx-auto max-w-2xl px-8 py-24 text-center"
    >
      <h1 className="text-3xl font-semibold text-gray-900">Page not found</h1>
      <p className="mt-4 text-gray-600">
        The requested handbook page does not exist.
      </p>
      <Link
        className="mt-6 inline-block font-medium text-gray-900 underline"
        to="/docs"
      >
        Return to the handbook overview
      </Link>
    </article>
  );
}
