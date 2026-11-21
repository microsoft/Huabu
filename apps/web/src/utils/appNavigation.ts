// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Router navigation for code that runs outside React (store actions, editor
 * click handlers). `App` registers the data router's `navigate` once.
 */
type AppNavigate = (to: string, options?: { state?: unknown }) => void;

let navigate: AppNavigate | null = null;

export function registerAppNavigate(next: AppNavigate | null): void {
  navigate = next;
}

/** Returns false when no router is mounted, e.g. in an isolated renderer. */
export function appNavigate(
  to: string,
  options?: { state?: unknown },
): boolean {
  if (!navigate) return false;
  navigate(to, options);
  return true;
}
