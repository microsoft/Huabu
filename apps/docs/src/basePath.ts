// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const docsBasePath = import.meta.env.BASE_URL;

export const routerBasename =
  docsBasePath === '/' ? '/' : docsBasePath.replace(/\/$/, '');

export function resolveWithBasePath(
  basePath: string,
  pathname: string,
): string {
  const normalizedPathname = `/${pathname.replace(/^\/+/, '')}`;
  if (basePath === '/') return normalizedPathname;

  const baseWithoutTrailingSlash = basePath.replace(/\/$/, '');
  if (
    normalizedPathname === baseWithoutTrailingSlash ||
    normalizedPathname.startsWith(basePath)
  ) {
    return normalizedPathname;
  }

  return `${baseWithoutTrailingSlash}${normalizedPathname}`;
}

export function withBasePath(pathname: string): string {
  return resolveWithBasePath(docsBasePath, pathname);
}
