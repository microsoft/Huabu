/**
 * Vitest setup file. Runs before any test file is imported.
 *
 * The test environment is `happy-dom` (see `vitest.config.ts`), which is
 * required because CommonJS modules like `cytoscape-layout-utilities`
 * — pulled in transitively when the shared canvas-engine command
 * registry loads — reference `window` at module-load time. happy-dom
 * supplies a real `window` shim, so no manual polyfill is needed here.
 *
 * Add globally-needed test setup (matchers, mocks) below.
 */
export {};
